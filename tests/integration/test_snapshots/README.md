# Test Snapshots

This directory contains Soroban SDK test snapshots used for deterministic integration testing.

## What are Test Snapshots?

Soroban SDK's `testutils` feature generates JSON snapshot files that capture the complete state of a test execution, including:

- **Contract state**: All ledger entries modified during the test
- **Authorization records**: All `require_auth` calls and their arguments
- **Event emissions**: Contract events emitted during execution
- **Budget consumption**: CPU and memory usage for each operation

## Snapshot Format

Each snapshot file (`.json`) contains:

```json
{
  "generators": {
    "address": <number>,    // Address generator counter
    "nonce": <number>,      // Nonce generator counter
    "mux_id": <number>      // Mux ID generator counter
  },
  "auth": [
    // Array of authorization call records per test step
    [
      [
        "<caller_address>",
        {
          "function": {
            "contract_fn": {
              "contract_address": "<contract_id>",
              "function_name": "<fn_name>",
              "args": [/* XDR-encoded arguments */]
            }
          },
          "sub_invocations": [/* nested auth calls */]
        }
      ]
    ]
  ],
  "ledger": {
    "protocol_version": 25,
    "sequence_number": <number>,
    "timestamp": <number>,
    "network_id": "<32-byte hex>",
    "base_reserve": <number>,
    "min_persistent_entry_ttl": 4096,
    "min_temp_entry_ttl": 16,
    "max_entry_ttl": 6312000,
    "ledger_entries": [
      // Array of [key, entry] pairs representing contract state
    ]
  }
}
```

## Naming Convention

- `test_<test_name>.1.json` - Snapshot for test `test_<test_name>`
- The `.1` suffix indicates this is the first (and typically only) snapshot for the test
- Budget tests are prefixed with `budget_` (e.g., `budget_set_vk_within_limit.1.json`)
- Stress tests are prefixed with `stress_` (e.g., `stress_many_daos.1.json`)

## Regenerating Snapshots

Snapshots are automatically regenerated when:
1. Tests are run with `SOROBAN_SNAPSHOT_EXACT=0` (allows updates)
2. The default mode updates snapshots when test outputs change

To force regeneration:
```bash
# Delete existing snapshots and re-run tests
rm tests/integration/test_snapshots/*.json
cargo test -p zkvote-integration-tests
```

## When to Update Snapshots

Update snapshots when:
- Contract storage schema changes
- Contract function signatures change
- New test scenarios are added
- Protocol version upgrades affect ledger format

**Do NOT** update snapshots if:
- Tests are failing unexpectedly
- You haven't intentionally changed contract behavior

## Reviewing Snapshot Changes

When reviewing PRs with snapshot changes:
1. Check that authorization records match expected admin/member permissions
2. Verify budget values are reasonable (not excessive increases)
3. Ensure ledger entries match the expected contract state
4. Large snapshot diffs may indicate unintended contract changes

## Related Documentation

- [Soroban SDK Testing](https://stellar.org/developers/docs/learn/smart-contract-testing)
- [Integration Tests README](../README.md)
