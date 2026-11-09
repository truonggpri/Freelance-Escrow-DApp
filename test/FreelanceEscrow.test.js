import { expect } from "chai";
import { network } from "hardhat";

// Hardhat creates an isolated in-memory EVM with funded fake wallets.
const { ethers, networkHelpers } = await network.create();
const { time } = networkHelpers;
const loadFixture = (fixture) => networkHelpers.loadFixture(fixture);
const ETH = ethers.parseEther("1");
const REVIEW = 3n * 24n * 60n * 60n;
const Status = Object.freeze({ Created: 0n, Submitted: 1n, Completed: 2n, Disputed: 3n, Cancelled: 4n });

async function deployFixture() {
  const [arbiter, client, freelancer, outsider, secondClient] = await ethers.getSigners();
  const escrow = await ethers.deployContract("FreelanceEscrow");
  await escrow.waitForDeployment();
  return { escrow, arbiter, client, freelancer, outsider, secondClient };
}

async function createJob(ctx, { amount = ETH, title = "Design a landing page", duration = 7n, freelancer = ctx.freelancer } = {}) {
  const tx = await ctx.escrow.connect(ctx.client).createJob(freelancer.address, title, duration, { value: amount });
  await tx.wait();
  return await ctx.escrow.jobCounter();
}

async function createdFixture() {
  const ctx = await deployFixture();
  await createJob(ctx);
  return ctx;
}

async function submittedFixture() {
  const ctx = await createdFixture();
  await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "https://github.com/example/project/commit/123")).wait();
  return ctx;
}

async function disputedFixture() {
  const ctx = await submittedFixture();
  await (await ctx.escrow.connect(ctx.client).raiseDispute(1n)).wait();
  return ctx;
}

async function contractBalance(ctx) {
  return ethers.provider.getBalance(await ctx.escrow.getAddress());
}

describe("FreelanceEscrow (simulated local EVM)", function () {
  describe("deployment and job creation", function () {
    it("sets the deployer as the immutable arbiter and the review period to 3 days", async function () {
      const { escrow, arbiter } = await loadFixture(deployFixture);
      expect(await escrow.arbiter()).to.equal(arbiter.address);
      expect(await escrow.REVIEW_PERIOD()).to.equal(REVIEW);
      expect(await escrow.jobCounter()).to.equal(0n);
    });

    it("holds a deposit, stores the participants, and emits JobCreated", async function () {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.escrow.connect(ctx.client).createJob(ctx.freelancer.address, "Logo", 7n, { value: ETH }))
        .to.emit(ctx.escrow, "JobCreated");
      const job = await ctx.escrow.jobs(1n);
      expect(job.id).to.equal(1n);
      expect(job.client).to.equal(ctx.client.address);
      expect(job.freelancer).to.equal(ctx.freelancer.address);
      expect(job.title).to.equal("Logo");
      expect(job.amount).to.equal(ETH);
      expect(job.workHash).to.equal("");
      expect(job.submittedAt).to.equal(0n);
      expect(job.status).to.equal(Status.Created);
      expect(await contractBalance(ctx)).to.equal(ETH);
    });

    it("separates deposits and states for multiple jobs", async function () {
      const ctx = await loadFixture(deployFixture);
      await createJob(ctx);
      await createJob(ctx, { amount: ethers.parseEther("0.5"), title: "Another task" });
      expect(await ctx.escrow.jobCounter()).to.equal(2n);
      expect(await contractBalance(ctx)).to.equal(ethers.parseEther("1.5"));
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "sha:abc")).wait();
      await (await ctx.escrow.connect(ctx.client).approveAndPay(1n)).wait();
      expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Completed);
      expect((await ctx.escrow.jobs(2n)).status).to.equal(Status.Created);
      expect(await contractBalance(ctx)).to.equal(ethers.parseEther("0.5"));
    });

    it("rejects a zero deposit", async function () {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.escrow.connect(ctx.client).createJob(ctx.freelancer.address, "Work", 1n, { value: 0n }))
        .to.be.revertedWith("Deposit must be positive");
    });

    it("rejects a zero freelancer address and self-hiring", async function () {
      const ctx = await loadFixture(deployFixture);
      for (const address of [ethers.ZeroAddress, ctx.client.address]) {
        await expect(ctx.escrow.connect(ctx.client).createJob(address, "Work", 1n, { value: ETH }))
          .to.be.revertedWith("Invalid freelancer");
      }
    });

    it("rejects an empty title or a zero-day duration", async function () {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.escrow.connect(ctx.client).createJob(ctx.freelancer.address, "", 1n, { value: ETH }))
        .to.be.revertedWith("Title is required");
      await expect(ctx.escrow.connect(ctx.client).createJob(ctx.freelancer.address, "Work", 0n, { value: ETH }))
        .to.be.revertedWith("Duration must be positive");
    });

    it("rejects unknown job IDs", async function () {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.escrow.approveAndPay(0n)).to.be.revertedWith("Job does not exist");
      await expect(ctx.escrow.approveAndPay(999n)).to.be.revertedWith("Job does not exist");
    });
  });

  describe("work submission", function () {
    it("records proof and timestamp only for the assigned freelancer", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.freelancer).submitWork(1n, "ipfs://CID"))
        .to.emit(ctx.escrow, "WorkSubmitted");
      const job = await ctx.escrow.jobs(1n);
      expect(job.workHash).to.equal("ipfs://CID");
      expect(job.submittedAt).to.be.greaterThan(0n);
      expect(job.status).to.equal(Status.Submitted);
    });

    it("prevents client or outsider from submitting work", async function () {
      const ctx = await loadFixture(createdFixture);
      for (const signer of [ctx.client, ctx.outsider]) {
        await expect(ctx.escrow.connect(signer).submitWork(1n, "proof"))
          .to.be.revertedWith("Only freelancer");
      }
    });

    it("rejects empty proof and a second submission", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.freelancer).submitWork(1n, ""))
        .to.be.revertedWith("Proof is required");
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "valid")).wait();
      await expect(ctx.escrow.connect(ctx.freelancer).submitWork(1n, "edited"))
        .to.be.revertedWith("Job is not open");
    });

    it("accepts a submission at exactly the deadline", async function () {
      const ctx = await loadFixture(createdFixture);
      const deadline = (await ctx.escrow.jobs(1n)).deadline;
      await time.setNextBlockTimestamp(deadline);
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "on-time")).wait();
      expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Submitted);
    });

    it("rejects submissions after the deadline", async function () {
      const ctx = await loadFixture(createdFixture);
      const deadline = (await ctx.escrow.jobs(1n)).deadline;
      await time.increaseTo(deadline + 1n);
      await expect(ctx.escrow.connect(ctx.freelancer).submitWork(1n, "late"))
        .to.be.revertedWith("Deadline passed");
    });
  });

  describe("client approval and payment", function () {
    it("pays the full deposit and marks the job Completed", async function () {
      const ctx = await loadFixture(submittedFixture);
      const balanceBefore = await ethers.provider.getBalance(ctx.freelancer.address);
      await expect(ctx.escrow.connect(ctx.client).approveAndPay(1n))
        .to.emit(ctx.escrow, "JobCompleted").withArgs(1n, ETH, 0n);
      expect(await ethers.provider.getBalance(ctx.freelancer.address) - balanceBefore).to.equal(ETH);
      expect(await contractBalance(ctx)).to.equal(0n);
      expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Completed);
    });

    it("requires submission and client authorization", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.client).approveAndPay(1n))
        .to.be.revertedWith("Work not submitted");
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "proof")).wait();
      for (const signer of [ctx.freelancer, ctx.outsider]) {
        await expect(ctx.escrow.connect(signer).approveAndPay(1n))
          .to.be.revertedWith("Only client");
      }
    });

    it("prevents paying the same job twice", async function () {
      const ctx = await loadFixture(submittedFixture);
      await (await ctx.escrow.connect(ctx.client).approveAndPay(1n)).wait();
      await expect(ctx.escrow.connect(ctx.client).approveAndPay(1n))
        .to.be.revertedWith("Work not submitted");
      expect(await contractBalance(ctx)).to.equal(0n);
    });

    it("still lets the client approve after the review period if no one has claimed", async function () {
      const ctx = await loadFixture(submittedFixture);
      const submittedAt = (await ctx.escrow.jobs(1n)).submittedAt;
      await time.increaseTo(submittedAt + REVIEW + 20n);
      await (await ctx.escrow.connect(ctx.client).approveAndPay(1n)).wait();
      expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Completed);
    });
  });

  describe("deadline cancellation", function () {
    it("only allows cancellation strictly after the deadline", async function () {
      const ctx = await loadFixture(createdFixture);
      const deadline = (await ctx.escrow.jobs(1n)).deadline;
      await expect(ctx.escrow.connect(ctx.client).cancelTimeout(1n))
        .to.be.revertedWith("Deadline not passed");
      await time.increaseTo(deadline);
      await expect(ctx.escrow.connect(ctx.client).cancelTimeout.staticCall(1n))
        .to.be.revertedWith("Deadline not passed");
      await time.increase(1);
      await expect(ctx.escrow.connect(ctx.client).cancelTimeout(1n))
        .to.emit(ctx.escrow, "JobCancelled").withArgs(1n);
      expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Cancelled);
      expect(await contractBalance(ctx)).to.equal(0n);
    });

    it("rejects cancellation from non-clients", async function () {
      const ctx = await loadFixture(createdFixture);
      await time.increaseTo((await ctx.escrow.jobs(1n)).deadline + 1n);
      for (const signer of [ctx.freelancer, ctx.outsider]) {
        await expect(ctx.escrow.connect(signer).cancelTimeout(1n))
          .to.be.revertedWith("Only client");
      }
    });

    it("never cancels a submitted job, even after the original deadline", async function () {
      const ctx = await loadFixture(submittedFixture);
      await time.increaseTo((await ctx.escrow.jobs(1n)).deadline + 1n);
      await expect(ctx.escrow.connect(ctx.client).cancelTimeout(1n))
        .to.be.revertedWith("Job is not open");
    });

    it("prevents cancellation after a refund", async function () {
      const ctx = await loadFixture(createdFixture);
      await time.increaseTo((await ctx.escrow.jobs(1n)).deadline + 1n);
      await (await ctx.escrow.connect(ctx.client).cancelTimeout(1n)).wait();
      await expect(ctx.escrow.connect(ctx.client).cancelTimeout(1n))
        .to.be.revertedWith("Job is not open");
    });
  });

  describe("freelancer review timeout", function () {
    it("only pays strictly after three days, not at exactly three days", async function () {
      const ctx = await loadFixture(submittedFixture);
      const submittedAt = (await ctx.escrow.jobs(1n)).submittedAt;
      await expect(ctx.escrow.connect(ctx.freelancer).claimTimeout(1n))
        .to.be.revertedWith("Review period not over");
      await time.increaseTo(submittedAt + REVIEW);
      await expect(ctx.escrow.connect(ctx.freelancer).claimTimeout.staticCall(1n))
        .to.be.revertedWith("Review period not over");
      await time.increase(1);
      await expect(ctx.escrow.connect(ctx.freelancer).claimTimeout(1n))
        .to.emit(ctx.escrow, "JobCompleted").withArgs(1n, ETH, 0n);
      expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Completed);
      expect(await contractBalance(ctx)).to.equal(0n);
    });

    it("requires the freelancer and an already-submitted job", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.freelancer).claimTimeout(1n))
        .to.be.revertedWith("Work not submitted");
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "proof")).wait();
      await time.increase(REVIEW + 1n);
      for (const signer of [ctx.client, ctx.outsider]) {
        await expect(ctx.escrow.connect(signer).claimTimeout(1n))
          .to.be.revertedWith("Only freelancer");
      }
    });

    it("cannot pay twice after a timeout claim", async function () {
      const ctx = await loadFixture(submittedFixture);
      await time.increase(REVIEW + 1n);
      await (await ctx.escrow.connect(ctx.freelancer).claimTimeout(1n)).wait();
      await expect(ctx.escrow.connect(ctx.freelancer).claimTimeout(1n))
        .to.be.revertedWith("Work not submitted");
      await expect(ctx.escrow.connect(ctx.client).approveAndPay(1n))
        .to.be.revertedWith("Work not submitted");
    });
  });

  describe("disputes and arbitration", function () {
    it("allows either party to dispute an open or submitted job", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.freelancer).raiseDispute(1n))
        .to.emit(ctx.escrow, "DisputeRaised").withArgs(1n, ctx.freelancer.address);
      expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Disputed);
      await expect(ctx.escrow.connect(ctx.client).approveAndPay(1n))
        .to.be.revertedWith("Work not submitted");
      await expect(ctx.escrow.connect(ctx.client).cancelTimeout(1n))
        .to.be.revertedWith("Job is not open");
    });

    it("allows a dispute after submission but only once", async function () {
      const ctx = await loadFixture(submittedFixture);
      await (await ctx.escrow.connect(ctx.client).raiseDispute(1n)).wait();
      await expect(ctx.escrow.connect(ctx.freelancer).raiseDispute(1n))
        .to.be.revertedWith("Cannot dispute this job");
    });

    it("does not let outsiders dispute or non-arbiters settle", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.outsider).raiseDispute(1n))
        .to.be.revertedWith("Only job parties");
      await (await ctx.escrow.connect(ctx.client).raiseDispute(1n)).wait();
      for (const signer of [ctx.client, ctx.freelancer, ctx.outsider]) {
        await expect(ctx.escrow.connect(signer).resolveDispute(1n, 50n))
          .to.be.revertedWith("Only arbiter");
      }
    });

    it("rejects arbitration on a normal job and shares over 100%", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, 50n))
        .to.be.revertedWith("Job is not disputed");
      await (await ctx.escrow.connect(ctx.client).raiseDispute(1n)).wait();
      await expect(ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, 101n))
        .to.be.revertedWith("Percent exceeds 100");
    });

    for (const percent of [0n, 25n, 100n]) {
      it(`settles a dispute with ${percent}% to the freelancer`, async function () {
        const ctx = await loadFixture(disputedFixture);
        const freelancerAmount = ETH * percent / 100n;
        const clientAmount = ETH - freelancerAmount;
        const clientBefore = await ethers.provider.getBalance(ctx.client.address);
        const freelancerBefore = await ethers.provider.getBalance(ctx.freelancer.address);
        await expect(ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, percent))
          .to.emit(ctx.escrow, "JobCompleted").withArgs(1n, freelancerAmount, clientAmount);
        expect(await ethers.provider.getBalance(ctx.client.address) - clientBefore).to.equal(clientAmount);
        expect(await ethers.provider.getBalance(ctx.freelancer.address) - freelancerBefore).to.equal(freelancerAmount);
        expect(await contractBalance(ctx)).to.equal(0n);
        expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Completed);
      });
    }

    it("assigns fractional wei rounding remainder to the client", async function () {
      const ctx = await loadFixture(deployFixture);
      await createJob(ctx, { amount: 101n });
      await (await ctx.escrow.connect(ctx.client).raiseDispute(1n)).wait();
      await expect(ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, 50n))
        .to.emit(ctx.escrow, "JobCompleted").withArgs(1n, 50n, 51n);
      expect(await contractBalance(ctx)).to.equal(0n);
    });

    it("makes resolution terminal (cannot resolve, submit, or dispute again)", async function () {
      const ctx = await loadFixture(disputedFixture);
      await (await ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, 50n)).wait();
      await expect(ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, 50n))
        .to.be.revertedWith("Job is not disputed");
      await expect(ctx.escrow.connect(ctx.freelancer).submitWork(1n, "again"))
        .to.be.revertedWith("Job is not open");
      await expect(ctx.escrow.connect(ctx.client).raiseDispute(1n))
        .to.be.revertedWith("Cannot dispute this job");
    });

    it("cannot dispute a cancelled or completed agreement", async function () {
      const ctx = await loadFixture(createdFixture);
      await time.increaseTo((await ctx.escrow.jobs(1n)).deadline + 1n);
      await (await ctx.escrow.connect(ctx.client).cancelTimeout(1n)).wait();
      await expect(ctx.escrow.connect(ctx.freelancer).raiseDispute(1n))
        .to.be.revertedWith("Cannot dispute this job");
    });
  });

  describe("failed ETH transfers", function () {
    it("atomically reverts a payout to a contract that rejects ETH", async function () {
      const ctx = await loadFixture(deployFixture);
      const rejectEther = await ethers.deployContract("RejectEther");
      await rejectEther.waitForDeployment();
      await createJob(ctx, { freelancer: { address: await rejectEther.getAddress() } });
      await (await rejectEther.submit(await ctx.escrow.getAddress(), 1n, "proof")).wait();
      await expect(ctx.escrow.connect(ctx.client).approveAndPay(1n))
        .to.be.revertedWith("ETH transfer failed");
      expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Submitted);
      expect(await contractBalance(ctx)).to.equal(ETH);
    });
  });
});
