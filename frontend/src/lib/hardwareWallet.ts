import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { APP_NETWORK_PASSPHRASE, walletSession } from "./walletSession";

/** Minimum wallet-kit surface required from a supported hardware module. */
export interface HardwareWalletTransport {
  getAddress(): Promise<{ address: string }>;
  signTransaction(
    xdr: string,
    options: { networkPassphrase: string; address: string },
  ): Promise<{ signedTxXdr: string }>;
}

export interface TransactionReview {
  /** Human-readable operation name (e.g. "Add DAO multisig signer"). */
  action: string;
  /** Exact target contract account, when this action invokes a contract. */
  contractId: string;
  /** Method/function being invoked. */
  method: string;
  /** Explicitly rendered parameters; never infer or hide these in the UI. */
  parameters: Readonly<Record<string, string>>;
}

export interface HardwareSigningRequest {
  transaction: Transaction;
  expectedSigner: string;
  networkPassphrase: string;
  review: TransactionReview;
}

export interface SignedHardwareTransaction {
  signedTransaction: Transaction;
  signer: string;
  transactionHash: string;
  review: TransactionReview;
}

export class HardwareSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HardwareSigningError";
  }
}

function transactionHash(transaction: Transaction): string {
  return transaction.hash().toString("hex");
}

/**
 * Sign only after checking the live network, current wallet session, device
 * address, immutable transaction hash, and caller-supplied review details.
 * This function has no software-key fallback: device errors abort the action.
 */
export async function signSorobanTransactionWithHardware(
  transport: HardwareWalletTransport,
  request: HardwareSigningRequest,
): Promise<SignedHardwareTransaction> {
  const { transaction, expectedSigner, networkPassphrase, review } = request;
  if (!review.action.trim() || !review.contractId.trim() || !review.method.trim()) {
    throw new HardwareSigningError("Transaction review must name the action, contract, and method");
  }
  if (!expectedSigner || !networkPassphrase) {
    throw new HardwareSigningError("Expected signer and network passphrase are required");
  }
  if (networkPassphrase !== APP_NETWORK_PASSPHRASE) {
    throw new HardwareSigningError("Transaction network does not match the application network");
  }

  walletSession.assertCanBuild(expectedSigner);
  const session = walletSession.snapshot();
  const { address } = await transport.getAddress();
  if (address !== expectedSigner) {
    throw new HardwareSigningError("Connected hardware-wallet address does not match the expected signer");
  }

  const unsignedHash = transactionHash(transaction);
  const { signedTxXdr } = await transport.signTransaction(transaction.toXDR(), {
    networkPassphrase,
    address: expectedSigner,
  });
  walletSession.checkpoint(session);

  let signedTransaction: Transaction;
  try {
    signedTransaction = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase) as Transaction;
  } catch {
    throw new HardwareSigningError("Hardware wallet returned invalid transaction XDR");
  }
  if (transactionHash(signedTransaction) !== unsignedHash) {
    throw new HardwareSigningError("Signed transaction does not match the reviewed transaction");
  }
  if (signedTransaction.signatures.length <= transaction.signatures.length) {
    throw new HardwareSigningError("Hardware wallet returned a transaction without an added signature");
  }

  return { signedTransaction, signer: address, transactionHash: unsignedHash, review };
}

/**
 * Merge distinct hardware signatures over the same envelope. Caller must
 * submit only after the on-chain multisig threshold is met. The contract still
 * verifies signatures and signer authorization; this helper does not replace
 * on-chain authorization.
 */
export function collectMultisigHardwareSignatures(
  unsignedTransaction: Transaction,
  signedTransactions: readonly SignedHardwareTransaction[],
  allowedSigners: readonly string[],
  threshold: number,
): Transaction {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > allowedSigners.length) {
    throw new HardwareSigningError("Multisig threshold must be between 1 and signer count");
  }

  const expectedHash = transactionHash(unsignedTransaction);
  const allowed = new Set(allowedSigners);
  const signers = new Set<string>();
  const signatures = new Map<string, Transaction["signatures"][number]>();

  for (const result of signedTransactions) {
    if (!allowed.has(result.signer)) {
      throw new HardwareSigningError("Signature came from an address outside the multisig signer set");
    }
    if (signers.has(result.signer)) {
      throw new HardwareSigningError("A multisig signer may contribute only once");
    }
    if (result.transactionHash !== expectedHash || transactionHash(result.signedTransaction) !== expectedHash) {
      throw new HardwareSigningError("Multisig signatures must cover the same reviewed transaction");
    }
    signers.add(result.signer);
    for (const signature of result.signedTransaction.signatures) {
      const key = `${signature.hint().toString("hex")}:${signature.signature().toString("hex")}`;
      signatures.set(key, signature);
    }
  }

  if (signers.size < threshold) {
    throw new HardwareSigningError(`Multisig threshold not met: ${signers.size}/${threshold} signatures`);
  }

  const merged = TransactionBuilder.fromXDR(unsignedTransaction.toXDR(), APP_NETWORK_PASSPHRASE) as Transaction;
  merged.signatures.push(...signatures.values());
  return merged;
}
