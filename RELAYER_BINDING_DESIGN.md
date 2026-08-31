# Relayer Binding Design (#361)

## Overview

This feature adds `relayer_address` as a public signal to the vote circuit, binding ZK proofs to specific relayers. This prevents front-running attacks where a malicious intermediary could intercept a proof, resubmit it through a different relayer for a different outcome, or delay/censor submissions.

## Motivation

From THREAT_MODEL.md, we currently document:

> **Can do (malicious)**: drop or delay submissions; replay the same payload (contract rejects reused nullifier); submit malformed tx to cause failure; **front-run ordering of votes** (tally unaffected because votes are additive); censor specific nullifiers by withholding.

While the tally is unaffected by front-running (votes are additive), voters may have preferences about:
1. **Voting order** - in elections with time-sensitive parameters
2. **Relayer identity** - delegation of trust to a specific relay operator
3. **Proof linkage** - preventing a proof from being used with different relayers

By binding the proof to the relayer's address, we prevent:
- **Cross-relayer proof reuse**: A proof generated for relayer A cannot be used with relayer B
- **Selective front-running**: A relayer cannot defer a vote and then rush it through at a strategic time
- **Proof harvesting**: A malicious observer cannot steal proofs and submit them through their own relayer

## Design Decisions

### 1. Relayer Address as Public Signal

**Choice**: Add `relayer_address` as the 7th public signal (after `numCandidates`).

**Why public, not private?**
- The relayer's address is public (it signs transactions)
- Contract must verify it matches the actual relayer submitting the tx
- Field membership validation is cheap on-chain
- Enables transparency: voters can confirm their proof is bound to their intended relayer

**Why not private?**
- Private signals complicate front-end proof generation (would need circuit-specific proof object per relayer)
- Public signals maintain the "proof as credentials" model where voters can share/verify bindings

### 2. Signal Constraints

**Relayer address format**: 
- Stellar contract address (56 chars, e.g., `CAUQ...YHG4`)
- Converted to U256 via standard address hashing (same as on-chain)
- Must be < BN254 scalar field modulus (r)
- Cannot be zero (validated on-chain)

**Circuit-level constraints**:
- Relayer address is unconstrained in the circuit (no equality check needed)
- Public input is a field element: `signal input relayerAddress`
- On-chain verification: contract reads relayer key from env and verifies match

### 3. Domain Separation

**Current nullifier**: `Poseidon(secret, daoId, proposalId)`

**Why not include relayer in nullifier?**
- Nullifiers must remain deterministic per (voter, election) pair
- Changing nullifiers would break double-vote prevention if the relayer changes
- Nullifier uniqueness is election-scoped, not relayer-scoped

**Solution**: Relayer binding is enforced via circuit public signal + contract verification, not via nullifier modification.

### 4. Field Membership Validation

**On-chain validation** (contract/voting.rs):
```rust
// Validate relayer_address is in BN254 scalar field
Self::assert_in_field(&env, &relayer_address)?;

// Validate relayer_address is non-zero
if relayer_address == U256::from_u32(&env, 0) {
    panic_with_error!(&env, VotingError::InvalidRelayerAddress);
}

// Extract actual relayer from transaction context
let actual_relayer = Self::get_relayer_from_env(&env);

// Verify proof signal matches actual relayer
if relayer_address != actual_relayer {
    panic_with_error!(&env, VotingError::RelayerMismatch);
}
```

### 5. Backward Compatibility

**Old proofs (6 signals) vs new proofs (7 signals)**:
- Old proofs will have IC vector length = 7 (6 signals + 1)
- New proofs will have IC vector length = 8 (7 signals + 1)
- Contract version increments to handle both (initial phase) or only accepts new proofs (breaking change)

**Recommended approach**: Breaking change in contract upgrade
- New circuit requires recompilation of all tests
- Old contracts accept 6-signal proofs, new contracts only accept 7-signal proofs
- Deployment: new voting contract with updated circuit
- Migration: clients regenerate proofs with new circuit

## Implementation Path

### Phase 1: Circuit Changes

1. Update `circuits/vote.circom`:
   - Add `signal input relayerAddress` as 7th public signal
   - Update component main statement: `component main {public [root, nullifier, daoId, proposalId, voteChoice, numCandidates, relayerAddress]}`
   - No circuit logic changes (just a pass-through signal)

2. Update `circuits/vote_v2.circom` (if exists):
   - Same changes as vote.circom

3. Recompile and regenerate Groth16 setup:
   ```bash
   cd circuits
   npm run compile
   npm run setup
   ```

4. Update verification keys:
   - New IC vector length: 8 (was 7)
   - Must regenerate all contract VKs

### Phase 2: Contract Changes

1. Update voting contract constants:
   ```rust
   const NUM_PUBLIC_SIGNALS: u32 = 7; // was 6
   const VOTE_CIRCUIT_IC_LEN: u32 = 8; // was 7 (= NUM_PUBLIC_SIGNALS + 1)
   ```

2. Add relayer address validation:
   ```rust
   // In vote() function, after nullifier validation
   Self::assert_in_field(&env, &relayer_address);
   if relayer_address == U256::from_u32(&env, 0) {
       panic_with_error!(&env, VotingError::InvalidRelayerAddress);
   }
   
   // Extract relayer address from env context
   let actual_relayer = env.current_contract_address(); // or from signer
   let relayer_u256 = Self::address_to_u256(&actual_relayer);
   
   if relayer_address != relayer_u256 {
       panic_with_error!(&env, VotingError::RelayerMismatch);
   }
   ```

3. Update public signals vector in vote():
   ```rust
   let relayer_signal = U256::from_address(&env, &actual_relayer);
   
   let pub_signals = soroban_sdk::vec![
       &env,
       root.clone(),
       nullifier.clone(),
       dao_signal,
       proposal_signal,
       vote_signal,
       num_candidates_signal,
       relayer_signal,  // NEW
   ];
   ```

4. Add new error variant:
   ```rust
   #[contracterror]
   #[derive(Copy, Clone, Eq, PartialEq, Debug)]
   pub enum VotingError {
       // ... existing errors ...
       InvalidRelayerAddress = 71,
       RelayerMismatch = 72,
   }
   ```

### Phase 3: Backend Changes

1. Update `backend/src/services/stellar.ts`:
   - Extract relayer address from keypair: `relayerKeypair.publicKey()`
   - Convert address to U256 field element for circuit

2. Update proof generation:
   - In `generateVoteProof()` (frontend or backend), add relayer_address to inputs

3. Update vote submission:
   ```typescript
   async submitVote(daoId, proposalId, choice, nullifier, root, proof, relayerAddress) {
       // proof now includes relayerAddress as public signal
       // contract verifies it matches the signer
   }
   ```

### Phase 4: Frontend Changes

1. Update `frontend/src/lib/zkproof.ts`:
   ```typescript
   export async function generateVoteProof(
       secret: string,
       salt: string,
       blindingFactor: string,
       daoId: bigint,
       proposalId: bigint,
       voteChoice: boolean,
       pathElements: string[],
       pathIndices: number[],
       relayerAddress: string,  // NEW
   ): Promise<Proof> {
       // Convert relayerAddress to field element
       const relayerAddressFr = await stellarAddressToFieldElement(relayerAddress);
       
       // Generate proof with new signal
       return await proveVote({
           secret,
           salt,
           blindingFactor,
           daoId,
           proposalId,
           voteChoice,
           numCandidates: 2,
           pathElements,
           pathIndices,
           relayerAddress: relayerAddressFr,  // NEW signal
       });
   }
   ```

2. Update vote submission UI:
   - Pass relayer address when generating proofs
   - Display confirmation: "Voting through relayer: [address]"

### Phase 5: Testing & Validation

1. **KAT (Known Answer Test)**:
   - Generate reference proof with known inputs including relayer_address
   - Verify circuit output matches expected hash
   - Verify on-chain Poseidon (for nullifier, not relayer) still matches
   - See `scripts/test/poseidon-kat.sh` for existing pattern

2. **Acceptance tests**:
   - Old proofs (6 signals) are rejected by new contract
   - New proofs (7 signals) with correct relayer_address pass
   - New proofs with wrong relayer_address fail
   - Nullifier collision detection unaffected (still per-election)

3. **Integration tests**:
   - Vote submission through different relayers with same proof fails
   - Vote submission with correct relayer succeeds
   - Backward compatibility: old client proofs rejected

### Phase 6: Documentation

1. Update THREAT_MODEL.md:
   - Section: "Relayer Binding (#361)"
   - Document front-running mitigation
   - Explain what still can't be prevented
   - Note privacy implications (relayer is public)

2. Update README.md:
   - Mention relayer binding in voting flow
   - Update circuit signature documentation

## Security Considerations

### What This Prevents
✅ Cross-relayer proof reuse (proof bound to specific relayer)
✅ Selective front-running via relayer switching
✅ Proof harvesting and replay by malicious observer

### What This Does NOT Prevent
❌ Front-running within a single relayer (still possible)
❌ Censorship (relayer can still drop votes)
❌ Ordering attacks if coordinated with proposer
❌ Nullifier censorship (relayer knows nullifier from proof)

### Privacy Impact
- Relayer address is now a public signal (visible on-chain)
- Voters who desire different relayers will have different proofs
- No new privacy leakage: relayer addresses are already known from transaction signing

### Attack Surface Changes

**New attack**: Faulty relayer address in circuit
- If `relayerAddress != actual_relayer`, vote is rejected
- Could be used for denial-of-service if frontend always sends wrong address
- Mitigated: Frontend must provide correct relayer address or users won't get votes through

**New dependency**: Relayer address encoding
- Must correctly map Stellar address → U256 field element
- Incorrect encoding breaks proofs
- Same encoding used everywhere (circuit, contract, frontend)

## Rollout Plan

1. **Week 1**: Implement circuit changes and regenerate setup
2. **Week 2**: Update contract and backend
3. **Week 3**: Update frontend and tests
4. **Week 4**: KAT and integration tests, documentation
5. **Deployment**: New contract version, clients upgrade to new frontend

## Alternatives Considered

### Option A: Include relayer in nullifier
- ❌ Would require regenerating all cached proofs if relayer changes
- ❌ Breaks election-scoped nullifier model
- ❌ Voter would need to re-vote with different relayer

### Option B: Relayer as optional signal
- ❌ Adds complexity (two circuit versions)
- ❌ Some proofs bound, some not (inconsistent security)
- ✅ Could enable gradual migration (not chosen for simplicity)

### Option C: Relayer binding via signature (off-circuit)
- ✅ No circuit changes needed
- ❌ Doesn't bind proof to relayer at proof level
- ❌ Relayer could strip signature and resubmit
- ❌ Less transparent to voters

### Chosen: Option A (public signal binding)
- ✅ Simple and clean
- ✅ Transparent to voters
- ✅ No off-chain signature management
- ✅ Backward compatible via version bumping
- ❌ Requires circuit recompilation

## References

- THREAT_MODEL.md §§ "Can do (malicious)" and "Relayer front-running mitigation"
- Issue #167: Merkle second-preimage, proof malleability, field validation (foundation for this work)
- Groth16 verification in voting contract (circuits/vote.circom, contracts/voting/src/lib.rs)
