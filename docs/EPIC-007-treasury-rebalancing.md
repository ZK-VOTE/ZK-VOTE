# EPIC-007: Treasury rebalancing

Rebalancing is policy-driven and disabled until governance approves a versioned policy containing target weights, tolerance bands, maximum trade size, slippage and price-impact limits, allowed assets, and a kill switch. The engine evaluates drift and creates a durable rebalance plan; it never swaps directly from a request handler.

Each plan records the quote, expiry, policy version, signer threshold, expected fees, and accounting postings. Partial fills park the plan and reconcile the filled quantity before any retry. Every completed swap posts balanced double-entry records for principal, fees, slippage, and dust. Depeg, stale-quote, liquidity, and venue-health guards cancel new trades and alert operators.

Rollout is staged: dry-run backtest, testnet execution, capped production cohort, then governed expansion. The ledger and on-chain balances are reconciled after every plan, and a mismatch pauses further plans.

