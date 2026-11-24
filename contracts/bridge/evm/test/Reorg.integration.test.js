const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Exercises EVM canonical-chain rollback semantics at the bridge boundary.
 * A transaction removed by a simulated reorg must not leave a nullifier
 * consumed, and the same vote must be admissible on the replacement chain.
 */
describe("Bridge reorg integration", function () {
  it("allows a vote to be resubmitted after its block is reorganized out", async function () {
    const [admin] = await ethers.getSigners();

    const MockVerifier = await ethers.getContractFactory("MockVerifier");
    const verifier = await MockVerifier.deploy();
    await verifier.waitForDeployment();
    await verifier.setShouldVerify(true);

    const Bridge = await ethers.getContractFactory("Bridge");
    const bridge = await Bridge.deploy(await verifier.getAddress(), 12345n);
    await bridge.waitForDeployment();

    const daoId = 7n;
    const proposalId = 11n;
    const nullifier = 123456n;
    const voteRoot = ethers.keccak256(ethers.toUtf8Bytes("reorg-vote-root"));
    const sbtRoot = ethers.keccak256(ethers.toUtf8Bytes("reorg-sbt-root"));
    const memberAddr = 98765n;
    const proof = ethers.hexlify(ethers.randomBytes(256));

    await bridge.updateSbtRoot(daoId, sbtRoot);
    await bridge.updateVoteRoot(daoId, proposalId, voteRoot);

    const snapshot = await ethers.provider.send("evm_snapshot", []);
    const orphanedTx = await bridge.castVote(
      daoId, proposalId, 1n, nullifier, voteRoot, sbtRoot, memberAddr, proof
    );
    const orphanedReceipt = await orphanedTx.wait();
    expect(await bridge.isNullifierUsed(daoId, proposalId, nullifier)).to.equal(true);
    expect(orphanedReceipt.logs.length).to.be.greaterThan(0);

    // Hardhat's EVM snapshot/revert models a reorg that removes the block.
    expect(await ethers.provider.send("evm_revert", [snapshot])).to.equal(true);
    expect(await bridge.isNullifierUsed(daoId, proposalId, nullifier)).to.equal(false);

    const replacementTx = await bridge.castVote(
      daoId, proposalId, 1n, nullifier, voteRoot, sbtRoot, memberAddr, proof
    );
    const replacementReceipt = await replacementTx.wait();
    expect(replacementReceipt.status).to.equal(1);
    expect(await bridge.isNullifierUsed(daoId, proposalId, nullifier)).to.equal(true);
  });
});
