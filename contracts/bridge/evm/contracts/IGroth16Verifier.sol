// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IGroth16Verifier
 * @notice Interface matching snarkjs-exported Verifier.sol for bridge.circom
 *         (9 public signals including chainId).
 */
interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[9] calldata publicSignals
    ) external view returns (bool);
}
