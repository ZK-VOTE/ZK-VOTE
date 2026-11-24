import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NETWORK_PASSPHRASE, __resetWalletSession, walletSession } from "./walletSession";
import {
  collectMultisigHardwareSignatures,
  HardwareSigningError,
  signSorobanTransactionWithHardware,
} from "./hardwareWallet";

const signer = Keypair.random();
const otherSigner = Keypair.random();
const destination = Keypair.random().publicKey();

function transaction() {
  return new TransactionBuilder(new Account(signer.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination, asset: Operation.payment ? undefined : undefined, amount: "1" } as never))
    .setTimeout(30)
    .build();
}

function mockTransport(address = signer.publicKey()) {
  return {
    getAddress: vi.fn().mockResolvedValue({ address }),
    signTransaction: vi.fn(async (xdr: string) => {
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      tx.sign(signer);
      return { signedTxXdr: tx.toXDR() };
    }),
  };
}

beforeEach(() => {
  __resetWalletSession();
  walletSession.sync(signer.publicKey(), APP_NETWORK_PASSPHRASE);
});

describe("hardware multisig signing", () => {
  it("checks device address and returns a signature over the reviewed envelope", async () => {
    const tx = transaction();
    const transport = mockTransport();
    const result = await signSorobanTransactionWithHardware(transport, {
      transaction: tx,
      expectedSigner: signer.publicKey(),
      networkPassphrase: APP_NETWORK_PASSPHRASE,
      review: {
        action: "Assign DAO administrator",
        contractId: Keypair.random().publicKey(),
        method: "assign_role",
        parameters: { daoId: "1", member: signer.publicKey(), role: "Admin" },
      },
    });

    expect(transport.getAddress).toHaveBeenCalledOnce();
    expect(transport.signTransaction).toHaveBeenCalledWith(tx.toXDR(), {
      networkPassphrase: APP_NETWORK_PASSPHRASE,
      address: signer.publicKey(),
    });
    expect(result.signedTransaction.signatures.length).toBeGreaterThan(tx.signatures.length);
  });

  it("fails closed on address mismatch and network mismatch", async () => {
    const request = {
      transaction: transaction(),
      expectedSigner: signer.publicKey(),
      networkPassphrase: APP_NETWORK_PASSPHRASE,
      review: { action: "Admin change", contractId: destination, method: "set_role", parameters: {} },
    };
    await expect(signSorobanTransactionWithHardware(mockTransport(otherSigner.publicKey()), request))
      .rejects.toThrow(/does not match/);
    await expect(signSorobanTransactionWithHardware(mockTransport(), {
      ...request,
      networkPassphrase: Networks.PUBLIC,
    })).rejects.toThrow(/does not match the application network/);
  });

  it("collects signatures only from unique authorized signers and enforces threshold", async () => {
    const unsigned = transaction();
    const signOne = async (kp: typeof signer) => {
      const signed = TransactionBuilder.fromXDR(unsigned.toXDR(), Networks.TESTNET);
      signed.sign(kp);
      return {
        signedTransaction: signed,
        signer: kp.publicKey(),
        transactionHash: unsigned.hash().toString("hex"),
        review: { action: "test", contractId: destination, method: "go", parameters: {} },
      };
    };
    const one = await signOne(signer);
    const two = await signOne(otherSigner);
    expect(() => collectMultisigHardwareSignatures(unsigned, [one], [signer.publicKey(), otherSigner.publicKey()], 2))
      .toThrow(/threshold not met/);
    const merged = collectMultisigHardwareSignatures(
      unsigned,
      [one, two],
      [signer.publicKey(), otherSigner.publicKey()],
      2,
    );
    expect(merged.signatures).toHaveLength(2);
    expect(() => collectMultisigHardwareSignatures(unsigned, [one, one], [signer.publicKey()], 1))
      .toThrow(/only once/);
  });

  it("rejects malformed or missing hardware signatures", async () => {
    const transport = mockTransport();
    transport.signTransaction.mockResolvedValue({ signedTxXdr: "not-xdr" });
    await expect(signSorobanTransactionWithHardware(transport, {
      transaction: transaction(),
      expectedSigner: signer.publicKey(),
      networkPassphrase: APP_NETWORK_PASSPHRASE,
      review: { action: "Admin change", contractId: destination, method: "set_role", parameters: {} },
    })).rejects.toBeInstanceOf(HardwareSigningError);
  });
});
