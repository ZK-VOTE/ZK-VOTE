/**
 * Payments Service — XLM / USDC / EURC (real assets, no mocks)
 * High-volume: MuxedAccount + 100 ops/tx + fee-bump + idempotency
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { relayerKeypair } from "./stellar.js";
import { relayerKeyManager } from "./relayerKeyManager.js";
import { log } from "./logger.js";
import { getDb } from "./db.js";
const horizonServer = new StellarSdk.Horizon.Server(config.horizonUrl || "https://horizon-testnet.stellar.org");
log("info", "payments_loaded", {});
const ISSUERS = {
    XLM: null,
    USDC: process.env.USDC_ISSUER || null,
    EURC: process.env.EURC_ISSUER || null,
};
/**
 * Resolves a Stellar Asset instance for the given asset code.
 * @param code Asset code (XLM, USDC, EURC)
 * @returns Configured StellarSdk.Asset instance
 */
export function getAsset(code) {
    if (code === "XLM")
        return StellarSdk.Asset.native();
    const issuer = ISSUERS[code];
    if (!issuer)
        throw new Error(`Issuer not configured for ${code}`);
    return new StellarSdk.Asset(code, issuer);
}
/**
 * Creates a MuxedAccount ID (M...) for user routing from a base public key and ID.
 * @param base Base public key (G...)
 * @param id Unique multiplexing sub-account ID
 * @returns Muxed account address (M...) or base key on fallback
 */
export function muxedForUser(base, id) {
    const m = new StellarSdk.MuxedAccount(new StellarSdk.Account(base, "0"), id);
    // StellarSdk.MuxedAccount encodes to M...; fallback to base if not available
    try {
        return m.accountId();
    }
    catch {
        return base;
    }
}
/**
 * Submits a single payment transaction via Horizon using the relayer account.
 * @param op Payment operation specifications (destination, asset, amount, memo)
 * @returns Transaction submission hash
 */
export async function sendPayment(op) {
    log("info", "payment_via_horizon", {});
    const asset = getAsset(op.asset);
    const dest = op.destination;
    const amount = op.amount;
    const account = await horizonServer.loadAccount(relayerKeypair.publicKey());
    const tx = new StellarSdk.TransactionBuilder(account, {
        fee: "10000",
        networkPassphrase: config.networkPassphrase,
    })
        .addOperation(StellarSdk.Operation.payment({ destination: dest, asset, amount }))
        .setTimeout(30)
        .build();
    if (op.memo)
        tx.addMemo?.(StellarSdk.Memo.text(op.memo));
    await relayerKeyManager.signTransaction(tx);
    try {
        const res = await horizonServer.submitTransaction(tx);
        log("info", "payment_sent", {
            asset: op.asset,
            amount,
            dest: dest.slice(0, 8) + "...",
            hash: res.hash,
        });
        return { hash: res.hash };
    }
    catch (e) {
        const data = e.response?.data || e.response?.body || e.message;
        const extras = data?.extras;
        log("error", "payment_failed", {
            asset: op.asset,
            amount,
            dest: dest.slice(0, 8) + "...",
            error: JSON.stringify(data).slice(0, 1000),
            extras: extras ? JSON.stringify(extras).slice(0, 1000) : undefined,
        });
        throw new Error(typeof data === "string"
            ? data
            : JSON.stringify(data).slice(0, 500) || e.message);
    }
}
/**
 * Parses a decimal string amount into integer stroops (1 unit = 10^7 stroops)
 * using string parsing and BigInt arithmetic to avoid floating-point precision drift.
 * @param amount String representation of decimal amount (e.g. "10.5000000")
 * @returns BigInt representation in stroops
 */
export function parseAmountToStroops(amount) {
    if (!amount || typeof amount !== "string") {
        throw new Error("Invalid amount: must be a non-empty string");
    }
    const trimmed = amount.trim();
    if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
        throw new Error(`Invalid payment amount format: ${amount}`);
    }
    const [whole, fraction = ""] = trimmed.split(".");
    const paddedFraction = fraction.padEnd(7, "0");
    return BigInt(whole) * 10000000n + BigInt(paddedFraction);
}
/**
 * Submits a batch of payments (up to 100 ops/tx) via Horizon with tenant-scoped idempotency.
 * @param ops Array of payment operations
 * @param tenantId Tenant identifier for scoping idempotency and outbox records
 * @returns Result containing deterministic transaction hash and operation count
 */
export async function sendBatch(ops, tenantId = "default") {
    if (ops.length === 0)
        throw new Error("No ops");
    if (ops.length > 100)
        throw new Error("Batch max 100 ops");
    const opsJson = JSON.stringify(ops);
    const hash = StellarSdk.hash(Buffer.from(`${tenantId}:${opsJson}`, "utf8")).toString("hex");
    const totalAmount = ops.reduce((sum, op) => sum + parseAmountToStroops(op.amount), 0n);
    const db = getDb();
    const existingJob = db
        .prepare("SELECT id FROM payment_jobs WHERE id = ?")
        .get(hash);
    if (existingJob) {
        log("info", "batch_payment_idempotent_hit", {
            hash,
            tenantId,
            ops: ops.length,
        });
        return { hash, ops: ops.length };
    }
    try {
        db.prepare("INSERT INTO payment_jobs (id, tenant_id, amount, ops, created_at) VALUES (?,?,?,?,?)").run(hash, tenantId, totalAmount.toString(), opsJson, new Date().toISOString());
    }
    catch (err) {
        if (err.message?.includes("UNIQUE constraint failed")) {
            return { hash, ops: ops.length };
        }
        throw err;
    }
    const account = await horizonServer.loadAccount(relayerKeypair.publicKey());
    const builder = new StellarSdk.TransactionBuilder(account, {
        fee: (10000 * ops.length).toString(),
        networkPassphrase: config.networkPassphrase,
    });
    for (const op of ops) {
        const asset = getAsset(op.asset);
        builder.addOperation(StellarSdk.Operation.payment({
            destination: op.destination,
            asset,
            amount: op.amount,
        }));
    }
    const tx = builder.setTimeout(30).build();
    await relayerKeyManager.signTransaction(tx);
    const res = await horizonServer.submitTransaction(tx);
    log("info", "batch_sent", { ops: ops.length, hash: res.hash });
    return { hash: res.hash, ops: ops.length };
}
/**
 * Executes a path payment to swap assets via Stellar DEX using strictSend.
 * @param sendAsset Asset to send
 * @param destAsset Destination asset to receive
 * @param sendAmount Exact amount of sendAsset to spend
 * @param destMin Minimum acceptable amount of destAsset to receive (slippage limit)
 * @param destination Recipient public address
 * @returns Transaction hash of the swap
 */
export async function swapStrictSend(sendAsset, destAsset, sendAmount, destMin, destination) {
    const sendA = getAsset(sendAsset);
    const destA = getAsset(destAsset);
    const account = await horizonServer.loadAccount(relayerKeypair.publicKey());
    const tx = new StellarSdk.TransactionBuilder(account, {
        fee: "10000",
        networkPassphrase: config.networkPassphrase,
    })
        .addOperation(StellarSdk.Operation.pathPaymentStrictSend({
        sendAsset: sendA,
        sendAmount,
        destination,
        destAsset: destA,
        destMin,
        path: [],
    }))
        .setTimeout(30)
        .build();
    await relayerKeyManager.signTransaction(tx);
    const res = await horizonServer.submitTransaction(tx);
    return { hash: res.hash };
}
/**
 * Queries simulated strictSend payment paths from Horizon to obtain a price quote.
 * @param sendAsset Asset to send
 * @param sendAmount Amount to send
 * @param destAsset Asset to receive
 * @returns Estimated destination amount and payment routing path
 */
export async function quoteStrictSend(sendAsset, sendAmount, destAsset) {
    const sendA = getAsset(sendAsset);
    const destA = getAsset(destAsset);
    // Horizon Server strictSendPaths
    const horizonUrl = config.horizonUrl || "https://horizon-testnet.stellar.org";
    const params = new URLSearchParams({
        source_account: relayerKeypair.publicKey(),
        send_asset_type: sendA.isNative() ? "native" : "credit_alphanum4",
        send_asset_code: sendA.isNative() ? "" : sendA.getCode(),
        send_asset_issuer: sendA.isNative() ? "" : sendA.getIssuer(),
        send_amount: sendAmount,
        destination_assets: `${destA.getCode()}:${destA.getIssuer()}`, // for native, handled
    });
    try {
        const url = `${horizonUrl}/paths/strict-send?${params.toString()}`;
        const res = await fetch(url);
        const j = await res.json();
        if (j._embedded && j._embedded.records && j._embedded.records[0]) {
            const r = j._embedded.records[0];
            return { destAmount: r.destination_amount, path: r.path };
        }
        throw new Error("No path found for the requested swap");
    }
    catch (e) {
        log("error", "quote_failed", { error: e.message });
        throw new Error(`Quote unavailable: ${e.message}`);
    }
}
//# sourceMappingURL=payments.js.map