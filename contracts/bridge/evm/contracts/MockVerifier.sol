// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Mock Groth16 Verifier
 * @notice FOR TESTS ONLY. Production must deploy the snarkjs-generated
 *         Verifier.sol from `circuits/compile_bridge.sh`.
 *
 * Defaults to rejecting proofs (`shouldVerify = false`) so a mistaken
 * production deploy cannot accept garbage (#650). Tests must explicitly
 * call setShouldVerify(true).
 */
contract MockVerifier {
    bool public shouldVerify = false;

    /// @dev Test harness only — no access control by design (tests toggle it).
    ///      Production must never deploy this contract.
    function setShouldVerify(bool _shouldVerify) external {
        shouldVerify = _shouldVerify;
    }

    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata /* b */,
        uint256[2] calldata c,
        uint256[9] calldata publicSignals
    ) external view returns (bool) {
        if (!shouldVerify) return false;

        // Reject zero proof points and zero memberAddr / chainId slots
        if (a[0] == 0 && a[1] == 0) return false;
        if (c[0] == 0 && c[1] == 0) return false;
        if (publicSignals[1] == 0) return false; // memberAddr
        if (publicSignals[8] == 0) return false; // chainId

        return true;
    }
}
