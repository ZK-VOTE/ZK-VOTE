// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title DaoMirror
 * @notice EVM satellite mirror for Soroban-canonical DAO governance (EPIC-002).
 *
 * Soroban is canonical. This contract only ever applies messages emitted by the
 * Soroban bridge (`contracts/bridge/soroban/src/dao_messages.rs`), and only:
 *
 * - once they are final on Soroban (`finalizedLedger >= sourceLedger + sorobanFinalityLedgers`);
 * - in per-DAO sequence order, exactly once (replay-safe);
 * - when they carry the supported `MESSAGE_VERSION` and name this chain and this contract.
 *
 * A message invalidated on Soroban (reorg) is rolled back here, or skipped if it
 * has not been applied yet. When the mirror holds something other than Soroban's
 * message for a sequence number, `resolveDivergence` replaces it with Soroban's.
 *
 * Trust model: the relayer attests `finalizedLedger` from the Soroban
 * `DaoMessageFinalized` event. The Soroban bridge refuses to acknowledge
 * anything that is not final there, so a relayer that skips the gate is
 * caught as a divergence.
 *
 * Locks are escrow accounting only; token custody lands with EPIC-002 Phase 5.
 */
contract DaoMirror {
    // ============================================
    // CONSTANTS & TYPES
    // ============================================

    uint32 public constant MESSAGE_VERSION = 1;
    bytes32 public constant DOMAIN = keccak256("ZKVOTE_DAO_MESSAGE_V1");
    uint64 public constant MAX_LOCK_TIMEOUT = 1 days;

    uint8 public constant KIND_MIRROR_ROOT = 1;
    uint8 public constant KIND_TALLY = 2;
    uint8 public constant KIND_LOCK = 3;
    uint8 public constant KIND_RELEASE = 4;
    uint8 public constant KIND_CANCEL = 5;

    /// @dev Field order and widths match `DaoMessage` on Soroban.
    struct DaoMessage {
        uint32 version;
        uint64 targetChainId;
        address targetMirror;
        uint64 daoId;
        uint64 seq;
        uint32 sourceLedger;
        uint8 kind;
        bytes body; // abi.encode of the variant's fields
    }

    enum LockStatus {
        None,
        Locked,
        Released,
        Cancelled,
        Refunded,
        Invalidated
    }

    struct Lock {
        LockStatus status;
        address recipient;
        address token;
        uint128 amount;
        uint64 expiresAt;
        uint64 seq; // message that last changed this lock
    }

    struct Tally {
        uint128 yes;
        uint128 no;
        bytes32 tallyRoot;
        uint64 seq;
    }

    struct Root {
        bytes32 root;
        uint64 memberCount;
        uint64 seq;
    }

    /// Why a message's effect was not applied (the sequence still advances).
    enum SkipReason {
        LockAlreadyActive,
        LockNotActive,
        LockExpired
    }

    // ============================================
    // EVENTS & ERRORS
    // ============================================

    event MessageApplied(uint64 indexed daoId, uint64 indexed seq, uint8 kind, bytes32 messageHash);
    event EffectSkipped(uint64 indexed daoId, uint64 indexed seq, SkipReason reason);
    event MessageInvalidated(uint64 indexed daoId, uint64 indexed seq, bool wasApplied);
    event RollbackIncomplete(uint64 indexed daoId, uint64 indexed seq);
    event DivergenceResolved(
        uint64 indexed daoId,
        uint64 indexed seq,
        bytes32 previousHash,
        bytes32 canonicalHash
    );
    event LockRefunded(uint64 indexed daoId, uint64 indexed proposalId);
    event RelayerUpdated(address indexed relayer);
    event SorobanFinalityUpdated(uint32 ledgers);
    event AdminTransferStarted(address indexed pendingAdmin);
    event AdminUpdated(address indexed admin);

    error OnlyAdmin();
    error OnlyPendingAdmin();
    error OnlyRelayer();
    error InvalidAddress();
    error InvalidFinality();
    error UnsupportedVersion(uint32 version);
    error WrongTarget();
    error UnknownKind(uint8 kind);
    error MalformedBody();
    error SorobanNotFinal(uint32 finalizedLedger, uint256 requiredLedger);
    error UnexpectedSequence(uint64 expected, uint64 got);
    error AlreadyInvalidated();
    error NotApplied();
    error NoDivergence();
    error LockNotRefundable();

    // ============================================
    // STATE
    // ============================================

    address public admin;
    address public pendingAdmin;
    address public relayer;
    uint32 public sorobanFinalityLedgers;

    /// Highest sequence number processed (applied or skipped as invalidated) per DAO.
    mapping(uint64 => uint64) public processedThrough;
    /// Hash of the message currently applied at (dao, seq); zero when none.
    mapping(uint64 => mapping(uint64 => bytes32)) public appliedHash;
    mapping(uint64 => mapping(uint64 => bool)) public invalidated;

    mapping(uint64 => Root) public mirrorRoots;
    /// True after the current root was invalidated, until a final root is applied.
    mapping(uint64 => bool) public mirrorRootStale;
    mapping(uint64 => mapping(uint64 => Tally)) public tallies; // dao => proposal
    mapping(uint64 => mapping(uint64 => Lock)) public locks; // dao => proposal

    // Rollback bookkeeping, per (dao, seq).
    mapping(uint64 => mapping(uint64 => uint8)) private appliedKind;
    mapping(uint64 => mapping(uint64 => bytes)) private appliedBody;
    mapping(uint64 => mapping(uint64 => bool)) private effectSkipped;
    mapping(uint64 => mapping(uint64 => Root)) private previousRoot;
    mapping(uint64 => mapping(uint64 => Tally)) private previousTally;
    mapping(uint64 => mapping(uint64 => Lock)) private previousLock;

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert OnlyRelayer();
        _;
    }

    constructor(address _relayer, uint32 _sorobanFinalityLedgers) {
        if (_relayer == address(0)) revert InvalidAddress();
        if (_sorobanFinalityLedgers == 0) revert InvalidFinality();
        admin = msg.sender;
        relayer = _relayer;
        sorobanFinalityLedgers = _sorobanFinalityLedgers;
    }

    // ============================================
    // ADMIN
    // ============================================

    function setRelayer(address _relayer) external onlyAdmin {
        if (_relayer == address(0)) revert InvalidAddress();
        relayer = _relayer;
        emit RelayerUpdated(_relayer);
    }

    function setSorobanFinalityLedgers(uint32 ledgers) external onlyAdmin {
        if (ledgers == 0) revert InvalidFinality();
        sorobanFinalityLedgers = ledgers;
        emit SorobanFinalityUpdated(ledgers);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert OnlyPendingAdmin();
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminUpdated(admin);
    }

    // ============================================
    // MESSAGES
    // ============================================

    /// @notice Same hash as `DaoMessage::hash` on Soroban.
    function hashMessage(DaoMessage calldata m) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    DOMAIN,
                    uint256(m.version),
                    uint256(m.targetChainId),
                    m.targetMirror,
                    uint256(m.daoId),
                    uint256(m.seq),
                    uint256(m.sourceLedger),
                    uint256(m.kind),
                    keccak256(m.body)
                )
            );
    }

    function nextSeq(uint64 daoId) external view returns (uint64) {
        return processedThrough[daoId] + 1;
    }

    /**
     * @notice Apply the next finalized Soroban message for a DAO.
     * @param finalizedLedger Soroban ledger of the message's `DaoMessageFinalized` event.
     */
    function applyMessage(DaoMessage calldata m, uint32 finalizedLedger) external onlyRelayer {
        _checkMessage(m, finalizedLedger);
        uint64 expected = processedThrough[m.daoId] + 1;
        if (m.seq != expected) revert UnexpectedSequence(expected, m.seq);

        processedThrough[m.daoId] = m.seq;
        bytes32 h = hashMessage(m);
        _record(m, h);
        _applyEffect(m.daoId, m.seq, m.kind, m.body);
        emit MessageApplied(m.daoId, m.seq, m.kind, h);
    }

    /**
     * @notice Soroban invalidated (dao, seq) after a reorg. An applied message is
     * rolled back; the next expected one is skipped so it can never be applied.
     */
    function invalidateMessage(uint64 daoId, uint64 seq) external onlyRelayer {
        if (invalidated[daoId][seq]) revert AlreadyInvalidated();
        uint64 done = processedThrough[daoId];
        bool wasApplied;
        if (seq == done + 1) {
            processedThrough[daoId] = seq;
        } else if (seq >= 1 && seq <= done) {
            _rollback(daoId, seq);
            wasApplied = true;
        } else {
            revert UnexpectedSequence(done + 1, seq);
        }
        invalidated[daoId][seq] = true;
        appliedHash[daoId][seq] = bytes32(0);
        emit MessageInvalidated(daoId, seq, wasApplied);
    }

    /**
     * @notice Replace whatever the mirror holds at (dao, seq) with Soroban's
     * finalized message. Soroban wins: the conflicting effect is rolled back
     * (where it is still current) and the canonical one applied.
     */
    function resolveDivergence(
        DaoMessage calldata canonical,
        uint32 finalizedLedger
    ) external onlyRelayer {
        _checkMessage(canonical, finalizedLedger);
        uint64 daoId = canonical.daoId;
        uint64 seq = canonical.seq;
        if (seq == 0 || seq > processedThrough[daoId]) revert NotApplied();

        bytes32 h = hashMessage(canonical);
        bytes32 previous = appliedHash[daoId][seq];
        if (previous == h) revert NoDivergence();
        if (previous != bytes32(0)) _rollback(daoId, seq);

        invalidated[daoId][seq] = false;
        _record(canonical, h);
        _applyEffect(daoId, seq, canonical.kind, canonical.body);
        emit DivergenceResolved(daoId, seq, previous, h);
    }

    /// @notice Anyone may mark an expired lock refunded (EPIC-002: 24h timeout).
    function refundExpired(uint64 daoId, uint64 proposalId) external {
        Lock storage lock = locks[daoId][proposalId];
        if (lock.status != LockStatus.Locked || block.timestamp < lock.expiresAt) {
            revert LockNotRefundable();
        }
        lock.status = LockStatus.Refunded;
        emit LockRefunded(daoId, proposalId);
    }

    // ============================================
    // INTERNAL
    // ============================================

    function _checkMessage(DaoMessage calldata m, uint32 finalizedLedger) internal view {
        if (m.version != MESSAGE_VERSION) revert UnsupportedVersion(m.version);
        if (m.targetChainId != block.chainid || m.targetMirror != address(this)) revert WrongTarget();
        if (m.body.length != _bodyLength(m.kind)) revert MalformedBody();
        uint256 required = uint256(m.sourceLedger) + sorobanFinalityLedgers;
        if (finalizedLedger < required) revert SorobanNotFinal(finalizedLedger, required);
    }

    function _bodyLength(uint8 kind) internal pure returns (uint256) {
        if (kind == KIND_MIRROR_ROOT) return 64;
        if (kind == KIND_TALLY) return 128;
        if (kind == KIND_LOCK) return 160;
        if (kind == KIND_RELEASE) return 32;
        if (kind == KIND_CANCEL) return 64;
        revert UnknownKind(kind);
    }

    function _record(DaoMessage calldata m, bytes32 h) internal {
        appliedHash[m.daoId][m.seq] = h;
        appliedKind[m.daoId][m.seq] = m.kind;
        appliedBody[m.daoId][m.seq] = m.body;
        effectSkipped[m.daoId][m.seq] = false;
    }

    function _applyEffect(uint64 daoId, uint64 seq, uint8 kind, bytes memory body) internal {
        if (kind == KIND_MIRROR_ROOT) {
            (bytes32 root, uint64 memberCount) = abi.decode(body, (bytes32, uint64));
            previousRoot[daoId][seq] = mirrorRoots[daoId];
            mirrorRoots[daoId] = Root(root, memberCount, seq);
            mirrorRootStale[daoId] = false;
        } else if (kind == KIND_TALLY) {
            (uint64 proposalId, uint128 yes, uint128 no, bytes32 tallyRoot) = abi.decode(
                body,
                (uint64, uint128, uint128, bytes32)
            );
            previousTally[daoId][seq] = tallies[daoId][proposalId];
            tallies[daoId][proposalId] = Tally(yes, no, tallyRoot, seq);
        } else if (kind == KIND_LOCK) {
            (
                uint64 proposalId,
                address recipient,
                address token,
                uint128 amount,
                uint64 timeout
            ) = abi.decode(body, (uint64, address, address, uint128, uint64));
            Lock storage lock = locks[daoId][proposalId];
            if (lock.status == LockStatus.Locked) {
                _skip(daoId, seq, SkipReason.LockAlreadyActive);
                return;
            }
            if (amount == 0 || timeout == 0 || timeout > MAX_LOCK_TIMEOUT) revert MalformedBody();
            previousLock[daoId][seq] = lock;
            locks[daoId][proposalId] = Lock(
                LockStatus.Locked,
                recipient,
                token,
                amount,
                uint64(block.timestamp) + timeout,
                seq
            );
        } else {
            // Release and cancel both start with the proposal id.
            uint64 proposalId = abi.decode(body, (uint64));
            Lock storage lock = locks[daoId][proposalId];
            if (lock.status != LockStatus.Locked) {
                _skip(daoId, seq, SkipReason.LockNotActive);
                return;
            }
            if (kind == KIND_RELEASE && block.timestamp >= lock.expiresAt) {
                _skip(daoId, seq, SkipReason.LockExpired);
                return;
            }
            previousLock[daoId][seq] = lock;
            lock.status = kind == KIND_RELEASE ? LockStatus.Released : LockStatus.Cancelled;
            lock.seq = seq;
        }
    }

    function _skip(uint64 daoId, uint64 seq, SkipReason reason) internal {
        effectSkipped[daoId][seq] = true;
        emit EffectSkipped(daoId, seq, reason);
    }

    /// @dev Undo the effect of the message applied at (dao, seq) if it is still current.
    function _rollback(uint64 daoId, uint64 seq) internal {
        if (effectSkipped[daoId][seq]) return;
        uint8 kind = appliedKind[daoId][seq];
        bytes memory body = appliedBody[daoId][seq];

        if (kind == KIND_MIRROR_ROOT) {
            if (mirrorRoots[daoId].seq != seq) return; // superseded by a later root
            mirrorRoots[daoId] = previousRoot[daoId][seq];
            mirrorRootStale[daoId] = true;
            return;
        }

        uint64 proposalId = abi.decode(body, (uint64));
        if (kind == KIND_TALLY) {
            if (tallies[daoId][proposalId].seq == seq) {
                tallies[daoId][proposalId] = previousTally[daoId][seq];
            } else {
                emit RollbackIncomplete(daoId, seq);
            }
            return;
        }

        Lock storage lock = locks[daoId][proposalId];
        if (lock.seq != seq) {
            // A later message already moved this lock on (e.g. it was released).
            emit RollbackIncomplete(daoId, seq);
            return;
        }
        if (kind == KIND_LOCK) {
            lock.status = LockStatus.Invalidated;
        } else {
            locks[daoId][proposalId] = previousLock[daoId][seq];
        }
    }
}
