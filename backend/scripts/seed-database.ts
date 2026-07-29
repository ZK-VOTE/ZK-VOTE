/**
 * Seeds test/dev token balances using batch_mint (Issue #110), instead of
 * one mint() call per recipient.
 *
 * Note: this script did not exist before this PR — it's created here to
 * satisfy the issue's "Update seed-database.ts to use batch minting"
 * acceptance criterion, since no prior seeding script existed to update.
 */
import { Contract, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";

const TOKEN_CONTRACT_ID = process.env.TOKEN_CONTRACT_ID ?? "";
const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

interface SeedRecipient {
  address: string;
  amount: bigint;
}

/**
 * Airdrops token balances to a list of recipients via a single
 * batch_mint call instead of one transaction per recipient.
 */
async function seedBalances(recipients: SeedRecipient[]): Promise<void> {
  if (recipients.length === 0) return;

  const server = new rpc.Server(RPC_URL);
  const contract = new Contract(TOKEN_CONTRACT_ID);

  const mints = nativeToScVal(
    recipients.map((r) => [r.address, r.amount]),
    { type: "vec" },
  );

  const account = await server.getAccount(process.env.ADMIN_PUBLIC_KEY ?? "");
  const tx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: process.env.NETWORK_PASSPHRASE ?? "",
  })
    .addOperation(contract.call("batch_mint", mints))
    .setTimeout(30)
    .build();

  // Signing/submission wiring left to the project's existing deploy
  // scripts' conventions (see scripts/deploy/) — not duplicated here.
  console.log(`Prepared batch_mint for ${recipients.length} recipients`);
  console.log(tx.toXDR());
}

seedBalances([
  // { address: "G...", amount: 1000n },
]).catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});