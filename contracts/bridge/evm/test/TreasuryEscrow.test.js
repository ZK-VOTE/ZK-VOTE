const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TreasuryEscrow", function () {
  let escrow, admin, relayer, depositor, recipient, other;
  const daoId = 1n;
  const proposalId = 7n;
  const amount = ethers.parseEther("1");
  const DAY = 24 * 60 * 60;

  beforeEach(async function () {
    [admin, relayer, depositor, recipient, other] = await ethers.getSigners();

    const Escrow = await ethers.getContractFactory("TreasuryEscrow");
    escrow = await Escrow.deploy(relayer.address);
    await escrow.waitForDeployment();
  });

  async function lockFunds(overrides = {}) {
    const lockId = await escrow.nextLockId();
    const tx = await escrow
      .connect(overrides.from ?? depositor)
      .lock(
        overrides.daoId ?? daoId,
        overrides.proposalId ?? proposalId,
        overrides.recipient ?? recipient.address,
        { value: overrides.value ?? amount },
      );
    await tx.wait();
    return lockId;
  }

  describe("Deployment", function () {
    it("sets admin to deployer", async function () {
      expect(await escrow.admin()).to.equal(admin.address);
    });

    it("sets relayer to the constructor argument", async function () {
      expect(await escrow.relayer()).to.equal(relayer.address);
    });

    it("defaults relayer to deployer when given the zero address", async function () {
      const Escrow = await ethers.getContractFactory("TreasuryEscrow");
      const e2 = await Escrow.deploy(ethers.ZeroAddress);
      await e2.waitForDeployment();
      expect(await e2.relayer()).to.equal(admin.address);
    });
  });

  describe("lock", function () {
    it("creates a lock bound to daoId/proposalId with a 24h timeout", async function () {
      const lockId = await lockFunds();
      const l = await escrow.getLock(lockId);

      expect(l.depositor).to.equal(depositor.address);
      expect(l.recipient).to.equal(recipient.address);
      expect(l.amount).to.equal(amount);
      expect(l.daoId).to.equal(daoId);
      expect(l.proposalId).to.equal(proposalId);
      expect(l.timeout).to.equal(BigInt(DAY));
      expect(l.status).to.equal(1n); // Locked
    });

    it("emits Locked", async function () {
      const mockProof = 0; // unused, placeholder to keep signature obvious
      await expect(
        escrow
          .connect(depositor)
          .lock(daoId, proposalId, recipient.address, { value: amount }),
      )
        .to.emit(escrow, "Locked")
        .withArgs(
          0n,
          daoId,
          proposalId,
          depositor.address,
          recipient.address,
          amount,
          BigInt(DAY),
        );
      void mockProof;
    });

    it("holds the funds in the contract", async function () {
      await lockFunds();
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(
        amount,
      );
    });

    it("rejects a zero-value lock", async function () {
      await expect(
        escrow
          .connect(depositor)
          .lock(daoId, proposalId, recipient.address, { value: 0 }),
      ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
    });

    it("rejects a zero-address recipient", async function () {
      await expect(
        escrow
          .connect(depositor)
          .lock(daoId, proposalId, ethers.ZeroAddress, { value: amount }),
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    });

    it("rejects plain transfers that bypass lock()", async function () {
      await expect(
        depositor.sendTransaction({
          to: await escrow.getAddress(),
          value: amount,
        }),
      ).to.be.revertedWithCustomError(escrow, "DirectDepositNotAllowed");
    });

    it("assigns increasing lock ids for successive locks", async function () {
      await lockFunds();
      const tx = await escrow
        .connect(depositor)
        .lock(daoId, proposalId, recipient.address, { value: amount });
      await expect(tx).to.emit(escrow, "Locked").withArgs(
        1n,
        daoId,
        proposalId,
        depositor.address,
        recipient.address,
        amount,
        BigInt(DAY),
      );
    });
  });

  describe("release", function () {
    it("requires a finalized Soroban approval: only the relayer may release", async function () {
      const lockId = await lockFunds();
      await expect(
        escrow.connect(other).release(lockId, 1n),
      ).to.be.revertedWithCustomError(escrow, "OnlyRelayer");
    });

    it("pays the recipient and marks the lock Released", async function () {
      const lockId = await lockFunds();
      const before = await ethers.provider.getBalance(recipient.address);

      await expect(escrow.connect(relayer).release(lockId, 42n))
        .to.emit(escrow, "Released")
        .withArgs(lockId, 42n);

      const after = await ethers.provider.getBalance(recipient.address);
      expect(after - before).to.equal(amount);

      const l = await escrow.getLock(lockId);
      expect(l.status).to.equal(2n); // Released
    });

    it("cannot release funds without ever locking (no finalized approval)", async function () {
      await expect(
        escrow.connect(relayer).release(0n, 1n),
      ).to.be.revertedWithCustomError(escrow, "LockNotFound");
    });

    it("cannot release the same lock twice", async function () {
      const lockId = await lockFunds();
      await escrow.connect(relayer).release(lockId, 1n);
      await expect(
        escrow.connect(relayer).release(lockId, 2n),
      ).to.be.revertedWithCustomError(escrow, "LockNotActive");
    });

    it("cannot release after the lock already timed out and was refunded", async function () {
      const lockId = await lockFunds();
      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await escrow.refund(lockId);

      await expect(
        escrow.connect(relayer).release(lockId, 1n),
      ).to.be.revertedWithCustomError(escrow, "LockNotActive");
    });
  });

  describe("cancel (early unlock via Soroban cancellation proof)", function () {
    it("only the relayer may cancel", async function () {
      const lockId = await lockFunds();
      await expect(
        escrow.connect(other).cancel(lockId, 1n),
      ).to.be.revertedWithCustomError(escrow, "OnlyRelayer");
    });

    it("returns funds to the depositor before the timeout elapses", async function () {
      const lockId = await lockFunds();
      const before = await ethers.provider.getBalance(depositor.address);

      await expect(escrow.connect(relayer).cancel(lockId, 7n))
        .to.emit(escrow, "Cancelled")
        .withArgs(lockId, 7n);

      const after = await ethers.provider.getBalance(depositor.address);
      expect(after - before).to.equal(amount);

      const l = await escrow.getLock(lockId);
      expect(l.status).to.equal(3n); // Cancelled
    });

    it("cannot cancel a lock twice", async function () {
      const lockId = await lockFunds();
      await escrow.connect(relayer).cancel(lockId, 7n);
      await expect(
        escrow.connect(relayer).cancel(lockId, 8n),
      ).to.be.revertedWithCustomError(escrow, "LockNotActive");
    });
  });

  describe("refund (timeout)", function () {
    it("reverts before the timeout has elapsed", async function () {
      const lockId = await lockFunds();
      await expect(
        escrow.refund(lockId),
      ).to.be.revertedWithCustomError(escrow, "TimeoutNotElapsed");
    });

    it("is reported as refundable only after the timeout", async function () {
      const lockId = await lockFunds();
      expect(await escrow.isRefundable(lockId)).to.equal(false);

      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);
      expect(await escrow.isRefundable(lockId)).to.equal(true);
    });

    it("lets the depositor reclaim funds exactly once after the timeout", async function () {
      const lockId = await lockFunds();
      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      const before = await ethers.provider.getBalance(depositor.address);
      // Anyone can call it (gas sponsorship); funds still go to depositor.
      const tx = await escrow.connect(other).refund(lockId);
      await expect(tx).to.emit(escrow, "Refunded").withArgs(lockId);
      await tx.wait();

      const after = await ethers.provider.getBalance(depositor.address);
      expect(after - before).to.equal(amount);

      await expect(
        escrow.connect(other).refund(lockId),
      ).to.be.revertedWithCustomError(escrow, "LockNotActive");
    });

    it("cannot be refunded after it was already released", async function () {
      const lockId = await lockFunds();
      await escrow.connect(relayer).release(lockId, 1n);

      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        escrow.refund(lockId),
      ).to.be.revertedWithCustomError(escrow, "LockNotActive");
    });
  });

  describe("replay protection", function () {
    it("rejects reusing a Soroban nonce across two different locks (no double-release)", async function () {
      const lockId1 = await lockFunds();
      const lockId2 = await lockFunds();

      await escrow.connect(relayer).release(lockId1, 999n);
      expect(await escrow.isNonceConsumed(999n)).to.equal(true);

      await expect(
        escrow.connect(relayer).release(lockId2, 999n),
      ).to.be.revertedWithCustomError(escrow, "NonceAlreadyConsumed");
    });

    it("rejects reusing a release nonce for a cancel call (no double-refund)", async function () {
      const lockId1 = await lockFunds();
      const lockId2 = await lockFunds();

      await escrow.connect(relayer).cancel(lockId1, 555n);
      await expect(
        escrow.connect(relayer).release(lockId2, 555n),
      ).to.be.revertedWithCustomError(escrow, "NonceAlreadyConsumed");
    });
  });

  describe("admin", function () {
    it("lets admin rotate the relayer", async function () {
      await expect(escrow.connect(admin).setRelayer(other.address))
        .to.emit(escrow, "RelayerUpdated")
        .withArgs(other.address);
      expect(await escrow.relayer()).to.equal(other.address);
    });

    it("rejects relayer rotation from non-admin", async function () {
      await expect(
        escrow.connect(other).setRelayer(other.address),
      ).to.be.revertedWithCustomError(escrow, "OnlyAdmin");
    });

    it("two-step transfers admin", async function () {
      await escrow.connect(admin).transferAdmin(other.address);
      expect(await escrow.pendingAdmin()).to.equal(other.address);
      expect(await escrow.admin()).to.equal(admin.address);

      await escrow.connect(other).acceptAdmin();
      expect(await escrow.admin()).to.equal(other.address);
    });

    it("rejects acceptAdmin from a non-pending address", async function () {
      await escrow.connect(admin).transferAdmin(other.address);
      await expect(
        escrow.connect(depositor).acceptAdmin(),
      ).to.be.revertedWithCustomError(escrow, "OnlyPendingAdmin");
    });
  });
});
