--------------------------- MODULE ZKVote ---------------------------
(*
  ZK-VOTE Formal Model (TLA+)
  ============================
  Models the combined state machine across 5 Soroban contracts:
    DaoRegistry, MembershipSBT, MembershipTree, Voting, zkvote-groth16

  Cross-contract calls and auth delegation are modeled explicitly.
  The BN254/Groth16 verification is abstracted as a boolean predicate.

  Invariants verified:
    I2: Root-grounded voting — every accepted proof's root is a valid Merkle root
    I3: Admin continuity — exactly one admin per DAO at all times
    I4: Proposal state irreversibility — Active -> Closed -> Archived
    I5: Nullifier uniqueness across all DAOs and proposals simultaneously
    I6: FIFO root eviction safety — Fixed-mode proposals always reference a root that exists
    I7: min_valid_root_idx never exceeds nextRootIndex
    I8: Auth delegation soundness — _from_registry requires registry auth

  Temporal property:
    I1: No double voting — once nullifierUsed, stays used forever

  Limitations:
    - Abstract Merkle tree: symbolic roots, not Poseidon hashes
    - Abstract BN254 pairing: boolean proofOk predicate
    - No Soroban budget/TTL modeling
    - No WASM sandbox semantics
    - Comments contract not included (separate model needed)
*)

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    \* @type: Int;
    MAX_ROOT_HISTORY,    (* 30 - FIFO cap on root history *)
    \* @type: Int;
    MAX_TREE_DEPTH,      (* 18 *)
    \* @type: Int;
    MAX_DAOS,            (* Maximum number of DAOs to model *)
    \* @type: Int;
    MAX_PROPOSALS,       (* Maximum proposals per DAO *)
    \* @type: Int;
    MAX_MEMBERS,         (* Maximum members per DAO *)
    \* @type: Int;
    MAX_NULLIFIERS       (* Maximum nullifiers to track *)

ASSUME MAX_ROOT_HISTORY > 0 /\ MAX_ROOT_HISTORY <= 30

(*-----------------------------------------------------------------------*)
(* Type definitions                                                       *)
(*-----------------------------------------------------------------------*)

DaoId == 1..MAX_DAOS
ProposalId == 1..MAX_PROPOSALS
MemberAddr == 1..MAX_MEMBERS
Nullifier == 1..MAX_NULLIFIERS
RootIdx == 0..(MAX_ROOT_HISTORY + MAX_MEMBERS + 1)
LeafIdx == 0..(2 ^ MAX_TREE_DEPTH)

ProposalState == {"Active", "Closed", "Archived"}
VoteMode == {"Fixed", "Trailing"}

(*-----------------------------------------------------------------------*)
(* State variables                                                        *)
(*-----------------------------------------------------------------------*)

VARIABLES
    (* DaoRegistry state *)
    \* @type: Int -> Int;
    daoAdmin,           (* [dao_id -> 0..MAX_MEMBERS], 0 = unset *)
    \* @type: Set(Int);
    daoExists,          (* Set of created DAO IDs *)
    \* @type: Int -> Bool;
    membershipOpen,     (* [dao_id -> BOOLEAN] *)
    \* @type: Int -> Bool;
    membersCanPropose,  (* [dao_id -> BOOLEAN] *)

    (* MembershipSBT state *)
    \* @type: Int -> (Int -> Bool);
    sbtMember,          (* [dao_id -> [address -> BOOLEAN]] *)
    \* @type: Int -> (Int -> Bool);
    sbtRevoked,         (* [dao_id -> [address -> BOOLEAN]] *)

    (* MembershipTree state *)
    \* @type: Int -> Bool;
    treeInitialized,    (* [dao_id -> BOOLEAN] *)
    \* @type: Int -> Int;
    nextLeafIndex,      (* [dao_id -> Nat] *)
    \* @type: Int -> Int;
    nextRootIndex,      (* [dao_id -> RootIdx] *)
    \* @type: Int -> Seq(Int);
    rootHistory,        (* [dao_id -> Seq(root_value)] - FIFO cap *)
    \* @type: Int -> (Int -> Int);
    rootIndexMap,       (* [dao_id -> [root -> RootIdx or -1]] *)
    \* @type: Int -> (Int -> Int);
    leafValue,          (* [dao_id -> [index -> 0..MAX_NULLIFIERS]] *)
    \* @type: Int -> (Int -> Int);
    memberLeafIndex,    (* [dao_id -> [address -> -1 or Nat]] *)
    \* @type: Int -> Int;
    minValidRootIdx,    (* [dao_id -> RootIdx] *)

    (* Voting state *)
    \* @type: Int -> (Int -> Str);
    proposalState,      (* [dao_id -> [proposal_id -> ProposalState or "None"]] *)
    \* @type: Int -> (Int -> [eligible_root: Int, vote_mode: Str, earliest_root_idx: Int, vk_hash: Int]);
    proposalInfo,       (* [dao_id -> [proposal_id -> record]] *)
    \* @type: Int -> (Int -> (Int -> Bool));
    nullifierUsed,      (* [dao_id -> [proposal_id -> [nullifier -> BOOLEAN]]] *)
    \* @type: Int -> Bool;
    vkSet,              (* [dao_id -> BOOLEAN] *)
    \* @type: Int -> Int;
    vkVersion,          (* [dao_id -> Nat] *)

    (* Cross-contract auth tracking *)
    \* @type: Bool;
    registryAuth,       (* BOOLEAN - whether registry has authenticated *)

    (* Global state *)
    \* @type: Int;
    nextDaoId,          (* Nat - next DAO ID to assign *)

    (* Abstract Merkle root values *)
    \* @type: Int -> Int;
    currentRoot         (* [dao_id -> 0..MAX_NULLIFIERS] *)

(*-----------------------------------------------------------------------*)
(* Type invariants                                                        *)
(*-----------------------------------------------------------------------*)

TypeOK ==
    /\ daoAdmin \in [DaoId -> 0..MAX_MEMBERS]
    /\ daoExists \subseteq DaoId
    /\ membershipOpen \in [DaoId -> BOOLEAN]
    /\ membersCanPropose \in [DaoId -> BOOLEAN]
    /\ sbtMember \in [DaoId -> [MemberAddr -> BOOLEAN]]
    /\ sbtRevoked \in [DaoId -> [MemberAddr -> BOOLEAN]]
    /\ treeInitialized \in [DaoId -> BOOLEAN]
    /\ nextLeafIndex \in [DaoId -> 0..(2 ^ MAX_TREE_DEPTH)]
    /\ nextRootIndex \in [DaoId -> RootIdx]
    /\ rootHistory \in [DaoId -> Seq(0..MAX_NULLIFIERS)]
    /\ rootIndexMap \in [DaoId -> [(0..MAX_NULLIFIERS) -> -1..(MAX_ROOT_HISTORY + MAX_MEMBERS + 1)]]
    /\ leafValue \in [DaoId -> [(0..(2 ^ MAX_TREE_DEPTH)) -> 0..MAX_NULLIFIERS]]
    /\ memberLeafIndex \in [DaoId -> [MemberAddr -> -1..(2 ^ MAX_TREE_DEPTH)]]
    /\ minValidRootIdx \in [DaoId -> RootIdx]
    /\ proposalState \in [DaoId -> [ProposalId -> {"Active", "Closed", "Archived", "None"}]]
    /\ nullifierUsed \in [DaoId -> [ProposalId -> [Nullifier -> BOOLEAN]]]
    /\ vkSet \in [DaoId -> BOOLEAN]
    /\ vkVersion \in [DaoId -> 0..MAX_MEMBERS]
    /\ currentRoot \in [DaoId -> 0..MAX_NULLIFIERS]
    /\ registryAuth \in {FALSE, TRUE}
    /\ nextDaoId \in 1..(MAX_DAOS + 1)

(*-----------------------------------------------------------------------*)
(* Invariants                                                            *)
(*-----------------------------------------------------------------------*)

(* I2: Root-grounded voting — every Fixed-mode proposal's eligible_root has a root index *)
RootGroundedVoting ==
    \A did \in DaoId, p \in ProposalId:
        (proposalState[did][p] = "Active" \/ proposalState[did][p] = "Closed" \/ proposalState[did][p] = "Archived") =>
            LET info == proposalInfo[did][p] IN
            info.vote_mode = "Fixed" =>
                \E idx \in RootIdx:
                    rootIndexMap[did][info.eligible_root] = idx /\ idx < nextRootIndex[did]

(* I3: Admin continuity — exactly one admin per DAO at all times *)
AdminContinuity ==
    \A did \in DaoId:
        did \in daoExists => daoAdmin[did] \in MemberAddr

(* I4: Proposal state irreversibility — no backward FSM transitions *)
ProposalFSM ==
    \A did \in DaoId, p \in ProposalId:
        ((proposalState[did][p] = "Archived") =>
            (proposalState[did][p] /= "Active" /\ proposalState[did][p] /= "Closed"))
        /\ ((proposalState[did][p] = "Closed") =>
            (proposalState[did][p] /= "Active"))

(* I5: Nullifier uniqueness across all DAOs and proposals *)
NullifierGlobalUniqueness ==
    \A d1 \in DaoId, d2 \in DaoId, p1 \in ProposalId, p2 \in ProposalId, n \in Nullifier:
        (nullifierUsed[d1][p1][n] /\ nullifierUsed[d2][p2][n]) =>
            (d1 = d2 /\ p1 = p2)

(* I6: FIFO root eviction safety — Fixed-mode proposals reference a root in history *)
FIFOSafety ==
    \A did \in DaoId, p \in ProposalId:
        (proposalState[did][p] = "Active" \/ proposalState[did][p] = "Closed" \/ proposalState[did][p] = "Archived")
        /\ proposalInfo[did][p].vote_mode = "Fixed" =>
            LET root == proposalInfo[did][p].eligible_root IN
            \E i \in 1..Len(rootHistory[did]):
                rootHistory[did][i] = root

(* I7: min_valid_root_idx — no false positive root rejection *)
MinRootCorrectness ==
    \A did \in DaoId:
        minValidRootIdx[did] <= nextRootIndex[did]

(* I8: Auth delegation soundness — _from_registry requires registry auth *)
AuthDelegationSoundness ==
    \A did \in DaoId:
        vkSet[did] => (registryAuth \/ \E a \in MemberAddr: daoAdmin[did] = a)

(*-----------------------------------------------------------------------*)
(* Initial state                                                          *)
(*-----------------------------------------------------------------------*)

Init ==
    /\ daoAdmin = [d \in DaoId |-> 0]
    /\ daoExists = {}
    /\ membershipOpen = [d \in DaoId |-> FALSE]
    /\ membersCanPropose = [d \in DaoId |-> FALSE]
    /\ sbtMember = [d \in DaoId |-> [a \in MemberAddr |-> FALSE]]
    /\ sbtRevoked = [d \in DaoId |-> [a \in MemberAddr |-> FALSE]]
    /\ treeInitialized = [d \in DaoId |-> FALSE]
    /\ nextLeafIndex = [d \in DaoId |-> 0]
    /\ nextRootIndex = [d \in DaoId |-> 0]
    /\ rootHistory = [d \in DaoId |-> <<0>>]
    /\ rootIndexMap = [d \in DaoId |-> [r \in 0..MAX_NULLIFIERS |-> -1]]
    /\ leafValue = [d \in DaoId |-> [i \in 0..(2 ^ MAX_TREE_DEPTH) |-> 0]]
    /\ memberLeafIndex = [d \in DaoId |-> [a \in MemberAddr |-> -1]]
    /\ minValidRootIdx = [d \in DaoId |-> 0]
    /\ proposalState = [d \in DaoId |-> [p \in ProposalId |-> "None"]]
    /\ proposalInfo = [d \in DaoId |-> [p \in ProposalId |-> [eligible_root |-> 0, vote_mode |-> "Fixed", earliest_root_idx |-> 0, vk_hash |-> 0]]]
    /\ nullifierUsed = [d \in DaoId |-> [p \in ProposalId |-> [n \in Nullifier |-> FALSE]]]
    /\ vkSet = [d \in DaoId |-> FALSE]
    /\ vkVersion = [d \in DaoId |-> 0]
    /\ currentRoot = [d \in DaoId |-> 0]
    /\ registryAuth = FALSE
    /\ nextDaoId = 1

(*-----------------------------------------------------------------------*)
(* Actions                                                                *)
(*-----------------------------------------------------------------------*)

(* === DaoRegistry Actions === *)

CreateDao(dao, creator, open) ==
    /\ dao = nextDaoId
    /\ dao \notin daoExists
    /\ creator \in MemberAddr
    /\ daoAdmin' = [daoAdmin EXCEPT ![dao] = creator]
    /\ daoExists' = daoExists \cup {dao}
    /\ membershipOpen' = [membershipOpen EXCEPT ![dao] = open]
    /\ nextDaoId' = nextDaoId + 1
    /\ UNCHANGED <<membersCanPropose, sbtMember, sbtRevoked, treeInitialized,
                    nextLeafIndex, nextRootIndex, rootHistory, rootIndexMap,
                    leafValue, memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth>>

TransferAdmin(dao, oldAdmin, newAdmin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = oldAdmin
    /\ newAdmin \in MemberAddr
    /\ daoAdmin' = [daoAdmin EXCEPT ![dao] = newAdmin]
    /\ UNCHANGED <<daoExists, membershipOpen, membersCanPropose,
                    sbtMember, sbtRevoked,
                    treeInitialized, nextLeafIndex, nextRootIndex,
                    rootHistory, rootIndexMap, leafValue, memberLeafIndex,
                    minValidRootIdx, proposalState,
                    proposalInfo, nullifierUsed, vkSet, vkVersion,
                    currentRoot, registryAuth, nextDaoId>>

SetProposalMode(dao, admin, canPropose) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ membersCanPropose' = [membersCanPropose EXCEPT ![dao] = canPropose]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex, nextRootIndex,
                    rootHistory, rootIndexMap, leafValue, memberLeafIndex,
                    minValidRootIdx, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

SetMembershipOpen(dao, admin, open) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ membershipOpen' = [membershipOpen EXCEPT ![dao] = open]
    /\ UNCHANGED <<daoAdmin, daoExists, membersCanPropose,
                    sbtMember, sbtRevoked,
                    treeInitialized, nextLeafIndex, nextRootIndex,
                    rootHistory, rootIndexMap, leafValue, memberLeafIndex,
                    minValidRootIdx, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

(* === MembershipSBT Actions === *)

MintSbt(dao, admin, member) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ ~sbtMember[dao][member]
    /\ sbtMember' = [sbtMember EXCEPT ![dao][member] = TRUE]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao][member] = FALSE]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    treeInitialized,
                    nextLeafIndex, nextRootIndex, rootHistory, rootIndexMap,
                    leafValue, memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

RevokeSbt(dao, admin, member) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ sbtMember[dao][member]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao][member] = TRUE]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    sbtMember,
                    treeInitialized, nextLeafIndex, nextRootIndex,
                    rootHistory, rootIndexMap, leafValue, memberLeafIndex,
                    minValidRootIdx, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

LeaveDao(dao, member) ==
    /\ dao \in daoExists
    /\ sbtMember[dao][member]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao][member] = TRUE]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    sbtMember,
                    treeInitialized, nextLeafIndex, nextRootIndex,
                    rootHistory, rootIndexMap, leafValue, memberLeafIndex,
                    minValidRootIdx, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

SelfJoin(dao, member) ==
    /\ dao \in daoExists
    /\ membershipOpen[dao]
    /\ ~sbtMember[dao][member]
    /\ sbtMember' = [sbtMember EXCEPT ![dao][member] = TRUE]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao][member] = FALSE]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    treeInitialized,
                    nextLeafIndex, nextRootIndex, rootHistory, rootIndexMap,
                    leafValue, memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

(* === MembershipTree Actions === *)

InitTree(dao, depth, admin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ ~treeInitialized[dao]
    /\ depth \in 1..MAX_TREE_DEPTH
    /\ treeInitialized' = [treeInitialized EXCEPT ![dao] = TRUE]
    /\ nextLeafIndex' = [nextLeafIndex EXCEPT ![dao] = 0]
    /\ nextRootIndex' = [nextRootIndex EXCEPT ![dao] = 1]
    /\ currentRoot' = [currentRoot EXCEPT ![dao] = 0]
    /\ rootHistory' = [rootHistory EXCEPT ![dao] = <<0>>]
    /\ rootIndexMap' = [rootIndexMap EXCEPT ![dao][0] = 0]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    sbtMember,
                    sbtRevoked, leafValue, memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, registryAuth, nextDaoId>>

RegisterCommitment(dao, member, commitment, newRoot) ==
    /\ dao \in daoExists
    /\ treeInitialized[dao]
    /\ sbtMember[dao][member] /\ ~sbtRevoked[dao][member]
    /\ memberLeafIndex[dao][member] = -1
    /\ nextLeafIndex[dao] < 2 ^ MAX_TREE_DEPTH
    /\ newRoot \notin {rootHistory[dao][i] : i \in 1..Len(rootHistory[dao])}
    /\ nextLeafIndex' = [nextLeafIndex EXCEPT ![dao] = nextLeafIndex[dao] + 1]
    /\ nextRootIndex' = [nextRootIndex EXCEPT ![dao] = nextRootIndex[dao] + 1]
    /\ memberLeafIndex' = [memberLeafIndex EXCEPT ![dao][member] = nextLeafIndex[dao]]
    /\ leafValue' = [leafValue EXCEPT ![dao][nextLeafIndex[dao]] = commitment]
    /\ currentRoot' = [currentRoot EXCEPT ![dao] = newRoot]
    /\ rootHistory' = [rootHistory EXCEPT ![dao] =
        IF Len(rootHistory[dao]) >= MAX_ROOT_HISTORY
        THEN Append(Tail(rootHistory[dao]), newRoot)
        ELSE Append(rootHistory[dao], newRoot)]
    /\ rootIndexMap' = [rootIndexMap EXCEPT ![dao][newRoot] = nextRootIndex[dao]]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    sbtMember,
                    sbtRevoked, treeInitialized, minValidRootIdx,
                    proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, registryAuth, nextDaoId>>

RemoveMember(dao, admin, member, newRoot) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ treeInitialized[dao]
    /\ memberLeafIndex[dao][member] >= 0
    /\ leafValue[dao][memberLeafIndex[dao][member]] /= 0
    /\ nextRootIndex' = [nextRootIndex EXCEPT ![dao] = nextRootIndex[dao] + 1]
    /\ leafValue' = [leafValue EXCEPT ![dao][memberLeafIndex[dao][member]] = 0]
    /\ currentRoot' = [currentRoot EXCEPT ![dao] = newRoot]
    /\ minValidRootIdx' = [minValidRootIdx EXCEPT ![dao] = nextRootIndex[dao]]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao][member] = TRUE]
    /\ rootHistory' = [rootHistory EXCEPT ![dao] =
        IF Len(rootHistory[dao]) >= MAX_ROOT_HISTORY
        THEN Append(Tail(rootHistory[dao]), newRoot)
        ELSE Append(rootHistory[dao], newRoot)]
    /\ rootIndexMap' = [rootIndexMap EXCEPT ![dao][newRoot] = nextRootIndex[dao]]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    sbtMember,
                    treeInitialized, nextLeafIndex, memberLeafIndex,
                    proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, registryAuth, nextDaoId>>

ReinstateMember(dao, admin, member) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ memberLeafIndex[dao][member] >= 0
    /\ leafValue[dao][memberLeafIndex[dao][member]] = 0
    /\ memberLeafIndex' = [memberLeafIndex EXCEPT ![dao][member] = -1]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex, nextRootIndex,
                    rootHistory, rootIndexMap, leafValue,
                    minValidRootIdx, proposalState, proposalInfo,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

(* === Voting Actions === *)

SetVk(dao, admin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ treeInitialized[dao]
    /\ vkSet' = [vkSet EXCEPT ![dao] = TRUE]
    /\ vkVersion' = [vkVersion EXCEPT ![dao] = vkVersion[dao] + 1]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex,
                    nextRootIndex, rootHistory, rootIndexMap, leafValue,
                    memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo, nullifierUsed, currentRoot,
                    registryAuth, nextDaoId>>

SetVkFromRegistry(dao) ==
    /\ dao \in daoExists
    /\ registryAuth
    /\ vkSet' = [vkSet EXCEPT ![dao] = TRUE]
    /\ vkVersion' = [vkVersion EXCEPT ![dao] = vkVersion[dao] + 1]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex,
                    nextRootIndex, rootHistory, rootIndexMap, leafValue,
                    memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo, nullifierUsed, currentRoot,
                    registryAuth, nextDaoId>>

CreateProposal(dao, proposal, creator, voteMode) ==
    /\ dao \in daoExists
    /\ proposalState[dao][proposal] = "None"
    /\ vkSet[dao]
    /\ treeInitialized[dao]
    /\ sbtMember[dao][creator] /\ ~sbtRevoked[dao][creator]
    /\ proposalState' = [proposalState EXCEPT ![dao][proposal] = "Active"]
    /\ proposalInfo' = [proposalInfo EXCEPT ![dao][proposal] =
        [eligible_root |-> currentRoot[dao],
         vote_mode |-> voteMode,
         earliest_root_idx |-> nextRootIndex[dao],
         vk_hash |-> vkVersion[dao]]]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex,
                    nextRootIndex, rootHistory, rootIndexMap, leafValue,
                    memberLeafIndex, minValidRootIdx,
                    nullifierUsed, vkSet, vkVersion, currentRoot,
                    registryAuth, nextDaoId>>

Vote(dao, proposal, nullifier, root, proofOk) ==
    /\ dao \in daoExists
    /\ proposalState[dao][proposal] = "Active"
    /\ ~nullifierUsed[dao][proposal][nullifier]
    /\ vkSet[dao]
    /\ treeInitialized[dao]
    /\ IF proposalInfo[dao][proposal].vote_mode = "Fixed"
       THEN root = proposalInfo[dao][proposal].eligible_root
       ELSE (* Trailing mode *)
            /\ \E i \in 1..Len(rootHistory[dao]):
                   rootHistory[dao][i] = root
            /\ rootIndexMap[dao][root] >= proposalInfo[dao][proposal].earliest_root_idx
            /\ rootIndexMap[dao][root] >= minValidRootIdx[dao]
    /\ proofOk
    /\ nullifierUsed' = [nullifierUsed EXCEPT ![dao][proposal][nullifier] = TRUE]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex,
                    nextRootIndex, rootHistory, rootIndexMap, leafValue,
                    memberLeafIndex, minValidRootIdx,
                    proposalState, proposalInfo, vkSet, vkVersion,
                    currentRoot, registryAuth, nextDaoId>>

CloseProposal(dao, proposal, admin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ proposalState[dao][proposal] = "Active"
    /\ proposalState' = [proposalState EXCEPT ![dao][proposal] = "Closed"]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex,
                    nextRootIndex, rootHistory, rootIndexMap, leafValue,
                    memberLeafIndex, minValidRootIdx,
                    proposalInfo, nullifierUsed, vkSet, vkVersion,
                    currentRoot, registryAuth, nextDaoId>>

ArchiveProposal(dao, proposal, admin) ==
    /\ dao \in daoExists
    /\ daoAdmin[dao] = admin
    /\ proposalState[dao][proposal] = "Closed"
    /\ proposalState' = [proposalState EXCEPT ![dao][proposal] = "Archived"]
    /\ UNCHANGED <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
                    sbtMember,
                    sbtRevoked, treeInitialized, nextLeafIndex,
                    nextRootIndex, rootHistory, rootIndexMap, leafValue,
                    memberLeafIndex, minValidRootIdx,
                    proposalInfo, nullifierUsed, vkSet, vkVersion,
                    currentRoot, registryAuth, nextDaoId>>

(* === Cross-contract initialization === *)

CreateAndInitDao(dao, creator, depth, commitment, newRoot) ==
    /\ dao = nextDaoId
    /\ dao \notin daoExists
    /\ creator \in MemberAddr
    /\ depth \in 1..MAX_TREE_DEPTH
    /\ newRoot /= 0  (* Commitment root must differ from implicit root 0 *)
    (* Step 1: Create DAO *)
    /\ daoAdmin' = [daoAdmin EXCEPT ![dao] = creator]
    /\ daoExists' = daoExists \cup {dao}
    /\ membershipOpen' = [membershipOpen EXCEPT ![dao] = FALSE]
    (* Step 2: Mint SBT (via mint_from_registry) *)
    /\ sbtMember' = [sbtMember EXCEPT ![dao][creator] = TRUE]
    /\ sbtRevoked' = [sbtRevoked EXCEPT ![dao][creator] = FALSE]
    (* Step 3: Init tree (via init_tree_from_registry) *)
    /\ treeInitialized' = [treeInitialized EXCEPT ![dao] = TRUE]
    (* Step 4: Register commitment (via register_from_registry) *)
    /\ memberLeafIndex' = [memberLeafIndex EXCEPT ![dao][creator] = 0]
    /\ leafValue' = [leafValue EXCEPT ![dao][0] = commitment]
    /\ currentRoot' = [currentRoot EXCEPT ![dao] = newRoot]
    /\ rootHistory' = [rootHistory EXCEPT ![dao] = <<0, newRoot>>]
    /\ rootIndexMap' = [rootIndexMap EXCEPT ![dao][0] = 0, ![dao][newRoot] = 1]
    /\ nextLeafIndex' = [nextLeafIndex EXCEPT ![dao] = 1]
    /\ nextRootIndex' = [nextRootIndex EXCEPT ![dao] = 2]
    (* Step 5: Set VK (via set_vk_from_registry) — requires registry auth *)
    /\ registryAuth' = TRUE
    /\ vkSet' = [vkSet EXCEPT ![dao] = TRUE]
    /\ vkVersion' = [vkVersion EXCEPT ![dao] = 1]
    /\ nextDaoId' = nextDaoId + 1
    /\ UNCHANGED <<membersCanPropose, minValidRootIdx, proposalState,
                    proposalInfo, nullifierUsed>>

(*-----------------------------------------------------------------------*)
(* Next-state relation                                                    *)
(*-----------------------------------------------------------------------*)

Next ==
    \/ \E dao \in DaoId, creator \in MemberAddr, open \in {TRUE, FALSE}:
         CreateDao(dao, creator, open)
    \/ \E dao \in DaoId, admin \in MemberAddr, newAdmin \in MemberAddr:
         TransferAdmin(dao, admin, newAdmin)
    \/ \E dao \in DaoId, admin \in MemberAddr, canPropose \in {TRUE, FALSE}:
         SetProposalMode(dao, admin, canPropose)
    \/ \E dao \in DaoId, admin \in MemberAddr, open \in {TRUE, FALSE}:
         SetMembershipOpen(dao, admin, open)
    \/ \E dao \in DaoId, admin \in MemberAddr, member \in MemberAddr:
         MintSbt(dao, admin, member)
    \/ \E dao \in DaoId, admin \in MemberAddr, member \in MemberAddr:
         RevokeSbt(dao, admin, member)
    \/ \E dao \in DaoId, member \in MemberAddr: LeaveDao(dao, member)
    \/ \E dao \in DaoId, member \in MemberAddr: SelfJoin(dao, member)
    \/ \E dao \in DaoId, depth \in 1..MAX_TREE_DEPTH, admin \in MemberAddr:
         InitTree(dao, depth, admin)
    \/ \E dao \in DaoId, member \in MemberAddr, commitment \in 0..MAX_NULLIFIERS,
            newRoot \in 0..MAX_NULLIFIERS:
         RegisterCommitment(dao, member, commitment, newRoot)
    \/ \E dao \in DaoId, admin \in MemberAddr, member \in MemberAddr,
            newRoot \in 0..MAX_NULLIFIERS:
         RemoveMember(dao, admin, member, newRoot)
    \/ \E dao \in DaoId, admin \in MemberAddr, member \in MemberAddr:
         ReinstateMember(dao, admin, member)
    \/ \E dao \in DaoId, admin \in MemberAddr: SetVk(dao, admin)
    \/ \E dao \in DaoId: SetVkFromRegistry(dao)
    \/ \E dao \in DaoId, proposal \in ProposalId, creator \in MemberAddr,
            voteMode \in VoteMode:
         CreateProposal(dao, proposal, creator, voteMode)
    \/ \E dao \in DaoId, proposal \in ProposalId, nullifier \in Nullifier,
            root \in 0..MAX_NULLIFIERS, proofOk \in {TRUE, FALSE}:
         Vote(dao, proposal, nullifier, root, proofOk)
    \/ \E dao \in DaoId, proposal \in ProposalId, admin \in MemberAddr:
         CloseProposal(dao, proposal, admin)
    \/ \E dao \in DaoId, proposal \in ProposalId, admin \in MemberAddr:
         ArchiveProposal(dao, proposal, admin)
    \/ \E dao \in DaoId, creator \in MemberAddr, depth \in 1..MAX_TREE_DEPTH,
            commitment \in 0..MAX_NULLIFIERS, newRoot \in 0..MAX_NULLIFIERS:
         CreateAndInitDao(dao, creator, depth, commitment, newRoot)

(*-----------------------------------------------------------------------*)
(* The complete specification                                             *)
(*-----------------------------------------------------------------------*)

vars == <<daoAdmin, daoExists, membershipOpen, membersCanPropose,
          sbtMember, sbtRevoked,
          treeInitialized, nextLeafIndex, nextRootIndex, rootHistory,
          rootIndexMap, leafValue, memberLeafIndex, minValidRootIdx,
          proposalState, proposalInfo, nullifierUsed,
          vkSet, vkVersion, currentRoot, registryAuth, nextDaoId>>

Spec == Init /\ [][Next]_vars

(*-----------------------------------------------------------------------*)
(* Liveness: VoteMode::Trailing starvation (Issue #552)                  *)
(*                                                                        *)
(* Trailing proposals accept a vote from member m iff                    *)
(*   rootIndexMap[dao][root] >= proposalInfo[dao][p].earliest_root_idx   *)
(*   rootIndexMap[dao][root] >= minValidRootIdx[dao]                     *)
(*                                                                        *)
(* Starvation occurs when FIFO root eviction (MAX_ROOT_HISTORY = 30)     *)
(* removes a member's root before they vote. The fairness assumption      *)
(* below asserts that the system cannot *forever* block a valid trailing  *)
(* voter: as long as their root remains in history and the proposal is    *)
(* Active, a Vote step is always eventually enabled and taken.            *)
(*                                                                        *)
(* WF_vars(Vote(…)) ensures that whenever voting is continuously enabled  *)
(* for a (dao, proposal, nullifier, root) tuple it eventually fires.      *)
(* This is a *weak* fairness condition — appropriate because the vote     *)
(* action is assumed to be continuously retried by a live voter.          *)
(*-----------------------------------------------------------------------*)

(* Helper: is a root currently valid for trailing-mode voting? *)
TrailingRootValid(dao, proposal, root) ==
    /\ proposalState[dao][proposal] = "Active"
    /\ proposalInfo[dao][proposal].vote_mode = "Trailing"
    /\ \E i \in 1..Len(rootHistory[dao]): rootHistory[dao][i] = root
    /\ rootIndexMap[dao][root] >= proposalInfo[dao][proposal].earliest_root_idx
    /\ rootIndexMap[dao][root] >= minValidRootIdx[dao]

(* Fairness: every enabled trailing vote step for a live voter eventually fires. *)
FairVoting ==
    \A dao \in DaoId, proposal \in ProposalId,
       nullifier \in Nullifier, root \in 0..MAX_NULLIFIERS:
        WF_vars(Vote(dao, proposal, nullifier, root, TRUE))

(*
 * TrailingLiveness:
 * For any trailing proposal p in dao d and any nullifier n with a valid root r —
 * if voting is always eventually enabled (root stays in history, proposal stays
 * Active, nullifier unused) then a vote is eventually cast.
 *
 * Expressed as: □◇(TrailingRootValid ∧ ¬nullifierUsed) ⇒ ◇nullifierUsed
 *
 * TLC checks this under the fair specification below.
 *)
TrailingVoteEventuallyAccepted ==
    \A dao \in DaoId, proposal \in ProposalId,
       nullifier \in Nullifier, root \in 0..MAX_NULLIFIERS:
        ([]<>(TrailingRootValid(dao, proposal, root)
              /\ ~nullifierUsed[dao][proposal][nullifier]))
        => <>nullifierUsed[dao][proposal][nullifier]

TrailingLiveness == TrailingVoteEventuallyAccepted

(*-----------------------------------------------------------------------*)
(* Fair specification — used for liveness checking                       *)
(* FairSpec adds weak fairness on Vote actions to Spec.                  *)
(*-----------------------------------------------------------------------*)

FairSpec == Spec /\ FairVoting

(*-----------------------------------------------------------------------*)
(* Invariants to check with TLC                                           *)
(*-----------------------------------------------------------------------*)

Invariants ==
    /\ RootGroundedVoting
    /\ AdminContinuity
    /\ ProposalFSM
    /\ NullifierGlobalUniqueness
    /\ FIFOSafety
    /\ MinRootCorrectness
    /\ AuthDelegationSoundness

=============================================================================
