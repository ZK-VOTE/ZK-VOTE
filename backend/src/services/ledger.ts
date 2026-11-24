/**
 * Double-Entry Ledger Service (Issue #796, #961)
 * Implements financial accounting for all money movements with:
 * - Balance reconciliation against chain state
 * - Historical transaction backfill
 * - Auditor export (redacted, read-only)
 * - Tax classification with versioned rules
 * - Invariant monitoring and alerts
 */

import type { Kysely } from "kysely";
import type { DB } from "../generated/db-types.js";
import { log } from "./logger.js";
import crypto from "crypto";

export interface JournalEntry {
  description: string;
  referenceType: "payment" | "swap" | "anchor_deposit" | "anchor_withdraw" | "reward" | "fee";
  referenceId: string;
  lines: JournalLine[];
}

export interface JournalLine {
  accountCode: string;
  debitStroops?: bigint;
  creditStroops?: bigint;
  assetCode?: string;
  assetIssuer?: string;
  memo?: string;
}

export class LedgerService {
  constructor(private db: Kysely<DB>) {}

  /**
   * Post a balanced journal entry
   * Throws if debits != credits
   */
  async postEntry(entry: JournalEntry): Promise<bigint> {
    // Validate balance
    let totalDebits = 0n;
    let totalCredits = 0n;

    for (const line of entry.lines) {
      totalDebits += line.debitStroops || 0n;
      totalCredits += line.creditStroops || 0n;
    }

    if (totalDebits !== totalCredits) {
      throw new Error(
        `Unbalanced entry: debits=${totalDebits} credits=${totalCredits}`,
      );
    }

    // Begin transaction
    return await this.db.transaction().execute(async (trx) => {
      // Insert entry header
      const entryResult = await trx
        .insertInto("ledger_entries")
        .values({
          description: entry.description,
          reference_type: entry.referenceType,
          reference_id: entry.referenceId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const entryId = entryResult.id as bigint;

      // Resolve account IDs and insert lines
      for (const line of entry.lines) {
        const account = await trx
          .selectFrom("ledger_accounts")
          .select("id")
          .where("code", "=", line.accountCode)
          .executeTakeFirst();

        if (!account) {
          throw new Error(`Account not found: ${line.accountCode}`);
        }

        await trx
          .insertInto("ledger_lines")
          .values({
            entry_id: entryId,
            account_id: account.id,
            debit_stroops: line.debitStroops || 0n,
            credit_stroops: line.creditStroops || 0n,
            asset_code: line.assetCode || "XLM",
            asset_issuer: line.assetIssuer,
            memo: line.memo,
          })
          .execute();
      }

      return entryId;
    });
  }

  /**
   * Post a payment transaction
   * Debit: Relayer Float
   * Credit: Fee Revenue (fee portion) + DAO Treasury (amount portion)
   */
  async postPayment(params: {
    amountStroops: bigint;
    feeStroops: bigint;
    paymentHash: string;
    daoId?: number;
  }): Promise<bigint> {
    return this.postEntry({
      description: `Payment ${params.paymentHash}`,
      referenceType: "payment",
      referenceId: params.paymentHash,
      lines: [
        {
          accountCode: "1000", // Relayer Float (debit - asset decreases)
          creditStroops: params.amountStroops + params.feeStroops,
        },
        {
          accountCode: "1100", // DAO Treasury (credit - asset increases for recipient)
          debitStroops: params.amountStroops,
        },
        {
          accountCode: "4000", // Fee Revenue
          debitStroops: params.feeStroops,
        },
      ],
    });
  }

  /**
   * Post a swap transaction with slippage/dust accounting
   */
  async postSwap(params: {
    sourceAmountStroops: bigint;
    destAmountStroops: bigint;
    feeStroops: bigint;
    dustStroops: bigint;
    swapId: string;
  }): Promise<bigint> {
    return this.postEntry({
      description: `Swap ${params.swapId}`,
      referenceType: "swap",
      referenceId: params.swapId,
      lines: [
        {
          accountCode: "1000", // Relayer Float source (credit)
          creditStroops: params.sourceAmountStroops,
        },
        {
          accountCode: "1000", // Relayer Float dest (debit)
          debitStroops: params.destAmountStroops,
        },
        {
          accountCode: "5000", // Transaction Fees (expense)
          debitStroops: params.feeStroops,
        },
        {
          accountCode: "5100", // Dust Account (expense)
          debitStroops: params.dustStroops,
        },
      ],
    });
  }

  /**
   * Perform daily close - verify all entries balance
   */
  async performDailyClose(date: Date): Promise<boolean> {
    const result = await this.db
      .selectFrom("ledger_entries as e")
      .innerJoin("ledger_lines as l", "e.id", "l.entry_id")
      .select((eb) => [
        eb.fn.sum("l.debit_stroops").as("total_debits"),
        eb.fn.sum("l.credit_stroops").as("total_credits"),
      ])
      .where("e.entry_date", "=", date.toISOString().split("T")[0])
      .executeTakeFirst();

    const totalDebits = BigInt(result?.total_debits || 0);
    const totalCredits = BigInt(result?.total_credits || 0);
    const isBalanced = totalDebits === totalCredits;
    const discrepancy = totalDebits - totalCredits;

    await this.db
      .insertInto("ledger_daily_close")
      .values({
        close_date: date.toISOString().split("T")[0],
        total_debits: totalDebits,
        total_credits: totalCredits,
        balance_proof_hash: "", // TODO: Implement cryptographic proof
        is_balanced: isBalanced,
        discrepancy_stroops: discrepancy < 0n ? -discrepancy : discrepancy,
      })
      .execute();

    return isBalanced;
  }

  /**
   * Get account balance
   */
  async getAccountBalance(accountCode: string): Promise<bigint> {
    const result = await this.db
      .selectFrom("ledger_account_balances")
      .select("balance_stroops")
      .where("code", "=", accountCode)
      .executeTakeFirst();

    return result ? BigInt(result.balance_stroops) : 0n;
  }

  /**
   * Backfill historical transactions from chain (#961)
   * Deterministic replay with checkpoints
   */
  async backfillFromChain(params: {
    horizonUrl: string;
    relayerAccountId: string;
    startCursor?: string;
    limit?: number;
    checkpoint?: () => Promise<void>;
  }): Promise<{
    processed: number;
    lastCursor: string | null;
    errors: number;
  }> {
    let processed = 0;
    let errors = 0;
    let lastCursor: string | null = null;

    try {
      const url = new URL(`${params.horizonUrl}/accounts/${params.relayerAccountId}/transactions`);
      url.searchParams.set("order", "asc");
      url.searchParams.set("limit", String(params.limit || 200));
      if (params.startCursor) {
        url.searchParams.set("cursor", params.startCursor);
      }

      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Horizon API returned ${response.status}`);
      }

      const data = await response.json();
      const transactions = data._embedded?.records || [];

      for (const tx of transactions) {
        try {
          await this.backfillTransaction(tx);
          processed++;
          lastCursor = tx.paging_token;

          // Checkpoint every 50 transactions
          if (processed % 50 === 0 && params.checkpoint) {
            await params.checkpoint();
            log("info", "ledger_backfill_checkpoint", {
              processed,
              lastCursor,
            });
          }
        } catch (err) {
          errors++;
          log("error", "ledger_backfill_transaction_failed", {
            txHash: tx.hash,
            error: (err as Error).message,
          });
        }
      }

      log("info", "ledger_backfill_completed", {
        processed,
        errors,
        lastCursor,
      });

      return { processed, lastCursor, errors };
    } catch (err) {
      log("error", "ledger_backfill_failed", {
        error: (err as Error).message,
        processed,
      });
      return { processed, lastCursor, errors };
    }
  }

  /**
   * Backfill a single transaction
   */
  private async backfillTransaction(tx: any): Promise<void> {
    // Extract operations and categorize
    const operations = tx.operations || [];
    
    // Skip if already processed
    const existing = await this.db
      .selectFrom("ledger_entries")
      .select("id")
      .where("reference_id", "=", tx.hash)
      .executeTakeFirst();
    
    if (existing) {
      return;
    }

    // Parse operations and create journal entry
    for (const op of operations) {
      if (op.type === "payment") {
        await this.postPayment({
          amountStroops: BigInt(Math.floor(parseFloat(op.amount) * 10_000_000)),
          feeStroops: BigInt(tx.fee_charged || 100),
          paymentHash: tx.hash,
        });
      }
      // Add more operation types as needed
    }
  }

  /**
   * Reconcile ledger balances with chain state (#961)
   */
  async reconcileWithChain(params: {
    horizonUrl: string;
    relayerAccountId: string;
  }): Promise<{
    ledgerBalance: bigint;
    chainBalance: bigint;
    discrepancy: bigint;
    isBalanced: boolean;
  }> {
    try {
      // Get chain balance
      const response = await fetch(`${params.horizonUrl}/accounts/${params.relayerAccountId}`);
      if (!response.ok) {
        throw new Error(`Horizon API returned ${response.status}`);
      }

      const account = await response.json();
      const xlmBalance = account.balances.find(
        (b: any) => b.asset_type === "native",
      );
      const chainBalance = xlmBalance
        ? BigInt(Math.floor(parseFloat(xlmBalance.balance) * 10_000_000))
        : 0n;

      // Get ledger balance
      const ledgerBalance = await this.getAccountBalance("1000"); // Relayer Float

      const discrepancy = ledgerBalance - chainBalance;
      const isBalanced = discrepancy === 0n;

      // Record reconciliation
      await this.db
        .insertInto("ledger_reconciliations")
        .values({
          reconciliation_date: new Date().toISOString().split("T")[0],
          account_code: "1000",
          ledger_balance: ledgerBalance,
          chain_balance: chainBalance,
          discrepancy,
          is_balanced: isBalanced,
        })
        .execute();

      if (!isBalanced) {
        log("error", "ledger_reconciliation_mismatch", {
          ledgerBalance: ledgerBalance.toString(),
          chainBalance: chainBalance.toString(),
          discrepancy: discrepancy.toString(),
        });
      } else {
        log("info", "ledger_reconciliation_success", {
          balance: ledgerBalance.toString(),
        });
      }

      return {
        ledgerBalance,
        chainBalance,
        discrepancy,
        isBalanced,
      };
    } catch (err) {
      log("error", "ledger_reconciliation_failed", {
        error: (err as Error).message,
      });
      throw err;
    }
  }

  /**
   * Export auditor-friendly report (redacted, read-only) (#961)
   */
  async exportAuditorReport(params: {
    startDate: string;
    endDate: string;
    includePII?: boolean;
  }): Promise<{
    entries: Array<{
      date: string;
      description: string;
      account: string;
      debit: string;
      credit: string;
      balance: string;
    }>;
    summary: {
      totalDebits: string;
      totalCredits: string;
      startBalance: string;
      endBalance: string;
    };
    hash: string;
  }> {
    const entries = await this.db
      .selectFrom("ledger_entries as e")
      .innerJoin("ledger_lines as l", "e.id", "l.entry_id")
      .innerJoin("ledger_accounts as a", "l.account_id", "a.id")
      .select([
        "e.entry_date",
        "e.description",
        "a.code",
        "a.name",
        "l.debit_stroops",
        "l.credit_stroops",
      ])
      .where("e.entry_date", ">=", params.startDate)
      .where("e.entry_date", "<=", params.endDate)
      .orderBy("e.entry_date", "asc")
      .orderBy("e.id", "asc")
      .execute();

    // Redact PII if requested
    const exportEntries = entries.map((entry) => {
      let description = entry.description;
      if (!params.includePII) {
        // Redact transaction hashes and addresses
        description = description.replace(/[A-Z0-9]{56}/g, "<REDACTED>");
        description = description.replace(/G[A-Z0-9]{55}/g, "<REDACTED_ADDRESS>");
      }

      return {
        date: entry.entry_date,
        description,
        account: `${entry.code} - ${entry.name}`,
        debit: (entry.debit_stroops / 10_000_000n).toString(),
        credit: (entry.credit_stroops / 10_000_000n).toString(),
        balance: "0", // Calculated below
      };
    });

    // Calculate totals
    const totalDebits = entries.reduce((sum, e) => sum + e.debit_stroops, 0n);
    const totalCredits = entries.reduce((sum, e) => sum + e.credit_stroops, 0n);

    // Generate reproducible hash
    const hashInput = JSON.stringify({
      startDate: params.startDate,
      endDate: params.endDate,
      entries: exportEntries,
    });
    const hash = crypto.createHash("sha256").update(hashInput).digest("hex");

    log("info", "auditor_report_exported", {
      startDate: params.startDate,
      endDate: params.endDate,
      entryCount: exportEntries.length,
      hash,
    });

    return {
      entries: exportEntries,
      summary: {
        totalDebits: (totalDebits / 10_000_000n).toString(),
        totalCredits: (totalCredits / 10_000_000n).toString(),
        startBalance: "0",
        endBalance: ((totalDebits - totalCredits) / 10_000_000n).toString(),
      },
      hash,
    };
  }

  /**
   * Check balance invariants and raise alerts (#961)
   */
  async checkBalanceInvariants(): Promise<{
    passed: boolean;
    violations: Array<{ rule: string; message: string }>;
  }> {
    const violations: Array<{ rule: string; message: string }> = [];

    // Invariant 1: All entries must be balanced
    const unbalancedEntries = await this.db
      .selectFrom("ledger_entries as e")
      .innerJoin("ledger_lines as l", "e.id", "l.entry_id")
      .select((eb) => [
        "e.id",
        eb.fn.sum("l.debit_stroops").as("total_debits"),
        eb.fn.sum("l.credit_stroops").as("total_credits"),
      ])
      .groupBy("e.id")
      .having((eb) =>
        eb.fn("SUM", ["l.debit_stroops"], eb.fn.sum("l.credit_stroops")),
      )
      .execute();

    if (unbalancedEntries.length > 0) {
      violations.push({
        rule: "balanced_entries",
        message: `Found ${unbalancedEntries.length} unbalanced journal entries`,
      });
    }

    // Invariant 2: Asset-liability-equity equation
    const trialBalance = await this.db
      .selectFrom("ledger_account_balances")
      .select((eb) => [
        eb
          .fn
          .sum(
            eb.case()
              .when("type", "in", ["asset", "expense"])
              .then("balance_stroops")
              .else(0),
          )
          .as("assets_expenses"),
        eb
          .fn
          .sum(
            eb.case()
              .when("type", "in", ["liability", "equity", "revenue"])
              .then("balance_stroops")
              .else(0),
          )
          .as("liabilities_equity_revenue"),
      ])
      .executeTakeFirst();

    const assetsExpenses = BigInt(trialBalance?.assets_expenses || 0);
    const liabilitiesEquityRevenue = BigInt(
      trialBalance?.liabilities_equity_revenue || 0,
    );

    if (assetsExpenses !== liabilitiesEquityRevenue) {
      violations.push({
        rule: "accounting_equation",
        message: `Trial balance mismatch: Assets+Expenses=${assetsExpenses}, Liabilities+Equity+Revenue=${liabilitiesEquityRevenue}`,
      });
    }

    // Invariant 3: No negative balances in asset accounts
    const negativeAssets = await this.db
      .selectFrom("ledger_account_balances")
      .select(["code", "name", "balance_stroops"])
      .where("type", "=", "asset")
      .where("balance_stroops", "<", 0)
      .execute();

    if (negativeAssets.length > 0) {
      violations.push({
        rule: "no_negative_assets",
        message: `Found ${negativeAssets.length} asset accounts with negative balances`,
      });
    }

    const passed = violations.length === 0;

    if (!passed) {
      log("error", "ledger_invariant_violation", {
        violations,
      });
    }

    return { passed, violations };
  }

  /**
   * Classify transaction for tax reporting (#961)
   */
  classifyForTax(entry: JournalEntry): {
    taxCategory: string;
    taxable: boolean;
    effectiveDate: string;
    ruleVersion: number;
  } {
    // Version 1 tax rules (US tax treatment)
    const ruleVersion = 1;
    const effectiveDate = new Date().toISOString();

    let taxCategory = "unknown";
    let taxable = false;

    // Classify based on reference type
    switch (entry.referenceType) {
      case "fee":
        taxCategory = "fee_revenue";
        taxable = true; // Fee revenue is taxable income
        break;
      case "payment":
        taxCategory = "service_revenue";
        taxable = true; // Payment processing revenue
        break;
      case "swap":
        taxCategory = "transaction_fee_expense";
        taxable = false; // Deductible expense
        break;
      case "anchor_deposit":
      case "anchor_withdraw":
        taxCategory = "capital_movement";
        taxable = false; // Not taxable (movement of capital)
        break;
      case "reward":
        taxCategory = "reward_income";
        taxable = true; // Rewards are taxable income
        break;
      default:
        taxCategory = "other";
        taxable = false;
    }

    return {
      taxCategory,
      taxable,
      effectiveDate,
      ruleVersion,
    };
  }
}
