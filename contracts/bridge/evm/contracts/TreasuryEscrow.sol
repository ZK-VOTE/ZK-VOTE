// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ZKVote Satellite Treasury Escrow
 * @notice Escrows EVM-side treasury funds for a DAO proposal whose
 *         governance decision is final on Soroban (the canonical chain).
 *         See docs/epics/EPIC-002-CROSS-CHAIN-DAO.md, Phase 5.
 *
 * Flow:
 * 1. A depositor locks funds for a Soroban (daoId, proposalId) pair,
 *    naming the recipient that should receive them on execution.
 * 2. Once the Soroban proposal reaches finality (approved), the relayer
 *    calls release() with the Soroban finality message's nonce. The
 *    nonce is consumed globally so the same message can never be
 *    replayed against this or any other lock.
 * 3. If the Soroban proposal is cancelled before finality, the relayer
 *    calls cancel() with the cancellation message's nonce to unlock the
 *    funds back to the depositor early.
 * 4. If neither happens within the timeout window, anyone can call
 *    refund() to return the funds to the depositor, exactly once.
 */
contract TreasuryEscrow {
    enum Status {
        None,
        Locked,
        Released,
        Cancelled,
        Refunded
    }

    struct Lock {
        address depositor;
        address recipient;
        uint256 amount;
        uint256 daoId;
        uint256 proposalId;
        uint64 createdAt;
        uint64 timeout;
        Status status;
    }

    // ============================================
    // STATE
    // ============================================

    uint64 public constant DEFAULT_TIMEOUT = 24 hours;

    uint256 public nextLockId;
    mapping(uint256 => Lock) public locks;

    /// @notice Soroban finality/cancellation message nonces already consumed.
    /// @dev Global (not per-lock) so a message cannot be replayed against
    /// this or any other lock, preventing double-release/double-refund.
    mapping(uint256 => bool) public consumedSorobanNonces;

    /// @notice Admin who can rotate the relayer and transfer admin.
    address public admin;
    address public pendingAdmin;

    /// @notice Address authorized to post Soroban finality/cancellation proofs.
    address public relayer;

    // ============================================
    // EVENTS
    // ============================================

    event Locked(
        uint256 indexed lockId,
        uint256 indexed daoId,
        uint256 indexed proposalId,
        address depositor,
        address recipient,
        uint256 amount,
        uint64 timeout
    );
    event Released(uint256 indexed lockId, uint256 sorobanNonce);
    event Cancelled(uint256 indexed lockId, uint256 sorobanNonce);
    event Refunded(uint256 indexed lockId);
    event RelayerUpdated(address indexed newRelayer);
    event AdminTransferStarted(address indexed pendingAdmin);
    event AdminUpdated(address indexed newAdmin);

    // ============================================
    // ERRORS
    // ============================================

    error OnlyAdmin();
    error OnlyRelayer();
    error OnlyPendingAdmin();
    error InvalidAddress();
    error ZeroAmount();
    error LockNotFound();
    error LockNotActive();
    error TimeoutNotElapsed();
    error NonceAlreadyConsumed();
    error TransferFailed();
    error DirectDepositNotAllowed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert OnlyRelayer();
        _;
    }

    constructor(address _relayer) {
        admin = msg.sender;
        relayer = _relayer == address(0) ? msg.sender : _relayer;
    }

    // ============================================
    // CORE: LOCK / RELEASE / CANCEL / REFUND
    // ============================================

    /**
     * @notice Lock funds in escrow for a Soroban DAO proposal.
     * @param daoId Soroban DAO identifier the lock is bound to.
     * @param proposalId Soroban proposal identifier the lock is bound to.
     * @param recipient Address to pay out to on release.
     */
    function lock(
        uint256 daoId,
        uint256 proposalId,
        address recipient
    ) external payable returns (uint256 lockId) {
        if (msg.value == 0) revert ZeroAmount();
        if (recipient == address(0)) revert InvalidAddress();

        lockId = nextLockId++;
        locks[lockId] = Lock({
            depositor: msg.sender,
            recipient: recipient,
            amount: msg.value,
            daoId: daoId,
            proposalId: proposalId,
            createdAt: uint64(block.timestamp),
            timeout: DEFAULT_TIMEOUT,
            status: Status.Locked
        });

        emit Locked(
            lockId,
            daoId,
            proposalId,
            msg.sender,
            recipient,
            msg.value,
            DEFAULT_TIMEOUT
        );
    }

    /**
     * @notice Release locked funds to the recipient following a finalized
     * Soroban approval. Only callable by the relayer, which must only
     * submit this after observing Soroban finality (canonical-chain
     * doctrine: EVM reflects Soroban governance, never overrides it).
     * @param sorobanNonce Unique nonce of the Soroban finality message.
     * Consuming it here makes replaying the same message impossible.
     */
    function release(
        uint256 lockId,
        uint256 sorobanNonce
    ) external onlyRelayer {
        Lock storage l = _requireActive(lockId);
        _consumeNonce(sorobanNonce);

        l.status = Status.Released;
        emit Released(lockId, sorobanNonce);
        _send(l.recipient, l.amount);
    }

    /**
     * @notice Unlock funds back to the depositor early following a Soroban
     * cancellation proof (e.g. the proposal was withdrawn or failed before
     * finality). Only callable by the relayer.
     * @param sorobanNonce Unique nonce of the Soroban cancellation message.
     */
    function cancel(uint256 lockId, uint256 sorobanNonce) external onlyRelayer {
        Lock storage l = _requireActive(lockId);
        _consumeNonce(sorobanNonce);

        l.status = Status.Cancelled;
        emit Cancelled(lockId, sorobanNonce);
        _send(l.depositor, l.amount);
    }

    /**
     * @notice Reclaim funds after the timeout has elapsed without a release
     * or cancellation. Callable by anyone (gas can be sponsored), but funds
     * always go to the original depositor. Can only succeed once per lock.
     */
    function refund(uint256 lockId) external {
        Lock storage l = _requireActive(lockId);
        if (block.timestamp < uint256(l.createdAt) + uint256(l.timeout)) {
            revert TimeoutNotElapsed();
        }

        l.status = Status.Refunded;
        emit Refunded(lockId);
        _send(l.depositor, l.amount);
    }

    // ============================================
    // ADMIN
    // ============================================

    /**
     * @notice Rotate the relayer authorized to post Soroban finality proofs.
     */
    function setRelayer(address newRelayer) external onlyAdmin {
        if (newRelayer == address(0)) revert InvalidAddress();
        relayer = newRelayer;
        emit RelayerUpdated(newRelayer);
    }

    /**
     * @notice Start two-step admin transfer.
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(newAdmin);
    }

    /**
     * @notice Accept admin role (must be pendingAdmin).
     */
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert OnlyPendingAdmin();
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminUpdated(admin);
    }

    // ============================================
    // VIEWS
    // ============================================

    function getLock(uint256 lockId) external view returns (Lock memory) {
        return locks[lockId];
    }

    function isNonceConsumed(
        uint256 sorobanNonce
    ) external view returns (bool) {
        return consumedSorobanNonces[sorobanNonce];
    }

    function isRefundable(uint256 lockId) external view returns (bool) {
        Lock storage l = locks[lockId];
        return
            l.status == Status.Locked &&
            block.timestamp >= uint256(l.createdAt) + uint256(l.timeout);
    }

    // ============================================
    // INTERNAL
    // ============================================

    function _requireActive(
        uint256 lockId
    ) internal view returns (Lock storage l) {
        l = locks[lockId];
        if (l.depositor == address(0)) revert LockNotFound();
        if (l.status != Status.Locked) revert LockNotActive();
    }

    function _consumeNonce(uint256 sorobanNonce) internal {
        if (consumedSorobanNonces[sorobanNonce]) revert NonceAlreadyConsumed();
        consumedSorobanNonces[sorobanNonce] = true;
    }

    function _send(address to, uint256 amount) internal {
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    /// @dev Reject plain transfers so every deposit is tracked by lock().
    receive() external payable {
        revert DirectDepositNotAllowed();
    }
}
