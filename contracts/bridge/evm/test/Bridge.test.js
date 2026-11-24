const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Bridge", function () {
  let bridge, verifier, owner, user, relayer;
  const sbtContractAddr = 12345n;
  const daoId = 1n;
  const proposalId = 1n;
  const voteChoice = 1n;
  const nullifier = 999n;
  const memberAddr = 0xabcdefn;
  const voteRoot = ethers.keccak256(ethers.toUtf8Bytes("test-vote-root"));
  const sbtRoot = ethers.keccak256(ethers.toUtf8Bytes("test-sbt-root"));

  beforeEach(async function () {
    [owner, user, relayer] = await ethers.getSigners();

    const MockVerifier = await ethers.getContractFactory("MockVerifier");
    verifier = await MockVerifier.deploy();
    await verifier.waitForDeployment();
    // Tests must explicitly enable the mock (#650)
    await verifier.setShouldVerify(true);

    const Bridge = await ethers.getContractFactory("Bridge");
    bridge = await Bridge.deploy(
      await verifier.getAddress(),
      sbtContractAddr
    );
    await bridge.waitForDeployment();

    await bridge.updateSbtRoot(daoId, sbtRoot);
    await bridge.updateVoteRoot(daoId, proposalId, voteRoot);
  });

  async function cast(
    overrides = {}
  ) {
    const mockProof = ethers.hexlify(ethers.randomBytes(256));
    return bridge.castVote(
      overrides.daoId ?? daoId,
      overrides.proposalId ?? proposalId,
      overrides.voteChoice ?? voteChoice,
      overrides.nullifier ?? nullifier,
      overrides.voteRoot ?? voteRoot,
      overrides.sbtRoot ?? sbtRoot,
      overrides.memberAddr ?? memberAddr,
      overrides.proof ?? mockProof
    );
  }

  describe("Deployment", function () {
    it("should set admin to deployer", async function () {
      expect(await bridge.admin()).to.equal(owner.address);
    });

    it("should set verifier address", async function () {
      expect(await bridge.verifier()).to.equal(await verifier.getAddress());
    });

    it("should set SBT contract address", async function () {
      expect(await bridge.sbtContractAddr()).to.equal(sbtContractAddr);
    });

    it("should set chain ID", async function () {
      expect(await bridge.chainId()).to.equal(31337n);
    });

    it("should set rootUpdater to deployer", async function () {
      expect(await bridge.rootUpdater()).to.equal(owner.address);
    });
  });

  describe("Admin functions", function () {
    it("should update SBT root", async function () {
      const newRoot = ethers.keccak256(ethers.toUtf8Bytes("new-root"));
      await bridge.updateSbtRoot(daoId, newRoot);
      expect(await bridge.sbtRoots(daoId)).to.equal(newRoot);
    });

    it("should enforce a configurable finality depth", async function () {
      await bridge.setFinalityDepth(25n);
      expect(await bridge.finalityDepth()).to.equal(25n);
    });

    it("should revert if non-admin updates SBT root", async function () {
      await expect(
        bridge.connect(user).updateSbtRoot(daoId, sbtRoot)
      ).to.be.revertedWithCustomError(bridge, "OnlyRootUpdater");
    });

    it("should update vote root", async function () {
      const newRoot = ethers.keccak256(ethers.toUtf8Bytes("new-vote-root"));
      await bridge.updateVoteRoot(daoId, proposalId, newRoot);
      expect(await bridge.voteRoots(daoId, proposalId)).to.equal(newRoot);
    });

    it("should propose and execute verifier after timelock", async function () {
      await bridge.proposeVerifier(user.address);
      expect(await bridge.pendingVerifier()).to.equal(user.address);
      // Immediate execute should fail
      await expect(bridge.executeVerifier()).to.be.revertedWithCustomError(
        bridge,
        "TimelockNotElapsed"
      );
      await ethers.provider.send("evm_increaseTime", [2 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await bridge.executeVerifier();
      expect(await bridge.verifier()).to.equal(user.address);
    });

    it("should reject immediate setVerifier", async function () {
      await expect(
        bridge.setVerifier(user.address)
      ).to.be.revertedWithCustomError(bridge, "TimelockNotElapsed");
    });

    it("should two-step transfer admin", async function () {
      await bridge.transferAdmin(user.address);
      expect(await bridge.pendingAdmin()).to.equal(user.address);
      expect(await bridge.admin()).to.equal(owner.address);
      await bridge.connect(user).acceptAdmin();
      expect(await bridge.admin()).to.equal(user.address);
    });

    it("should reject immediate setAdmin", async function () {
      await expect(
        bridge.setAdmin(user.address)
      ).to.be.revertedWithCustomError(bridge, "OnlyPendingAdmin");
    });
  });

  describe("castVote", function () {
    it("should emit VoteForwarded on valid proof with memberAddr", async function () {
      await expect(cast())
        .to.emit(bridge, "VoteForwarded")
        .withArgs(
          daoId,
          proposalId,
          nullifier,
          voteChoice,
          voteRoot,
          memberAddr,
          31337n
        );
    });

    it("should reject zero memberAddr", async function () {
      await expect(cast({ memberAddr: 0n })).to.be.revertedWithCustomError(
        bridge,
        "ZeroMemberAddr"
      );
    });

    it("should reject unanchored voteRoot", async function () {
      const arbitrary = ethers.keccak256(ethers.toUtf8Bytes("attacker-tree"));
      await expect(cast({ voteRoot: arbitrary })).to.be.revertedWithCustomError(
        bridge,
        "VoteRootMismatch"
      );
    });

    it("should reject when vote root not set", async function () {
      await expect(
        cast({ proposalId: 99n })
      ).to.be.revertedWithCustomError(bridge, "VoteRootNotSet");
    });

    it("should mark nullifier as used", async function () {
      await cast();
      expect(
        await bridge.isNullifierUsed(daoId, proposalId, nullifier)
      ).to.be.true;
    });

    it("should revert on double-voting (same nullifier)", async function () {
      await cast();
      await expect(cast()).to.be.revertedWithCustomError(bridge, "NullifierUsed");
    });

    it("should revert on zero nullifier", async function () {
      await expect(cast({ nullifier: 0n })).to.be.revertedWithCustomError(
        bridge,
        "ZeroNullifier"
      );
    });

    it("should revert on invalid vote choice", async function () {
      await expect(cast({ voteChoice: 2n })).to.be.revertedWithCustomError(
        bridge,
        "InvalidVoteChoice"
      );
    });

    it("should revert when SBT root not set", async function () {
      await expect(cast({ daoId: 999n })).to.be.revertedWithCustomError(
        bridge,
        "SbtRootNotSet"
      );
    });

    it("should revert when provided sbtRoot is not finalized", async function () {
      const mockProof = ethers.hexlify(ethers.randomBytes(256));
      const newRoot = ethers.keccak256(ethers.toUtf8Bytes("fresh-root"));
      await bridge.setFinalityDepth(12n);
      await bridge.updateSbtRoot(daoId, newRoot);

      await expect(
        bridge.castVote(
          daoId,
          proposalId,
          voteChoice,
          nullifier + 10n,
          voteRoot,
          newRoot,
          memberAddr,
          mockProof
        )
      ).to.be.revertedWithCustomError(bridge, "SbtRootNotFinalized");
    });

    it("should revert when provided sbtRoot mismatches", async function () {
      const wrongRoot = ethers.keccak256(ethers.toUtf8Bytes("wrong"));
      await expect(cast({ sbtRoot: wrongRoot })).to.be.revertedWithCustomError(
        bridge,
        "SbtRootNotSet"
      );
    });

    it("should revert on invalid proof (mock verifier rejects)", async function () {
      await verifier.setShouldVerify(false);
      await expect(cast()).to.be.revertedWithCustomError(bridge, "InvalidProof");
    });

    it("should allow different nullifiers for same DAO+proposal", async function () {
      await cast({ nullifier: 100n });
      await cast({ nullifier: 200n });
      expect(await bridge.isNullifierUsed(daoId, proposalId, 100n)).to.be.true;
      expect(await bridge.isNullifierUsed(daoId, proposalId, 200n)).to.be.true;
    });
  });

  describe("Gas benchmarks", function () {
    it("should cast vote under 500k gas", async function () {
      const tx = await cast();
      const receipt = await tx.wait();
      expect(receipt.gasUsed).to.be.lt(500000n);
    });
  });
});
