import { expect } from "chai";
import { network } from "hardhat";

// Hardhat creates an isolated in-memory EVM with funded fake wallets.
const { ethers, networkHelpers } = await network.create();
const { time } = networkHelpers;
const loadFixture = (fixture) => networkHelpers.loadFixture(fixture);
const ETH = ethers.parseEther("1");
const DAY = 24n * 60n * 60n;
const REVIEW = 3n * DAY;
const REVISION_PERIOD = 3n * DAY;
const ARBITER_TIMEOUT = 7n * DAY;
const MAX_REVISIONS = 2n;
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

/** Withdraws for `signer` and returns the ETH actually received (net of gas). */
async function withdrawAndMeasure(ctx, signer) {
  const before = await ethers.provider.getBalance(signer.address);
  const receipt = await (await ctx.escrow.connect(signer).withdraw()).wait();
  const after = await ethers.provider.getBalance(signer.address);
  return after - before + receipt.gasUsed * receipt.gasPrice;
}

describe("FreelanceEscrow (simulated local EVM)", function () {
  describe("deployment and job creation", function () {
    it("sets the deployer as the immutable arbiter and the protocol constants", async function () {
      const { escrow, arbiter } = await loadFixture(deployFixture);
      expect(await escrow.arbiter()).to.equal(arbiter.address);
      expect(await escrow.REVIEW_PERIOD()).to.equal(REVIEW);
      expect(await escrow.REVISION_PERIOD()).to.equal(REVISION_PERIOD);
      expect(await escrow.ARBITER_TIMEOUT()).to.equal(ARBITER_TIMEOUT);
      expect(await escrow.MAX_REVISIONS()).to.equal(MAX_REVISIONS);
      expect(await escrow.ADVANCE_PERCENT()).to.equal(50n);
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
      expect(job.revisions).to.equal(0n);
      expect(job.disputedAt).to.equal(0n);
      expect(job.cancelRequestedBy).to.equal(ethers.ZeroAddress);
      expect(job.advancePaid).to.equal(0n);
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
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH);
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

  describe("per-user job index", function () {
    it("lists the jobs of both the client and the freelancer", async function () {
      const ctx = await loadFixture(deployFixture);
      await createJob(ctx);                                     // 1: client -> freelancer
      await createJob(ctx, { freelancer: ctx.outsider });       // 2: client -> outsider
      await (await ctx.escrow.connect(ctx.secondClient)
        .createJob(ctx.freelancer.address, "Other", 3n, { value: ETH })).wait(); // 3: secondClient -> freelancer

      const ids = async (signer) => (await ctx.escrow.getUserJobs(signer.address)).map(Number);
      expect(await ids(ctx.client)).to.deep.equal([1, 2]);
      expect(await ids(ctx.freelancer)).to.deep.equal([1, 3]);
      expect(await ids(ctx.outsider)).to.deep.equal([2]);
      expect(await ids(ctx.arbiter)).to.deep.equal([]);
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
    it("credits the full deposit, marks the job Completed, and the freelancer can withdraw it", async function () {
      const ctx = await loadFixture(submittedFixture);
      await expect(ctx.escrow.connect(ctx.client).approveAndPay(1n))
        .to.emit(ctx.escrow, "JobCompleted").withArgs(1n, ETH, 0n);
      expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Completed);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH);
      expect(await contractBalance(ctx)).to.equal(ETH); // still held until withdrawn

      expect(await withdrawAndMeasure(ctx, ctx.freelancer)).to.equal(ETH);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(0n);
      expect(await contractBalance(ctx)).to.equal(0n);
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
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH);
    });

    it("still lets the client approve after the review period if no one has claimed", async function () {
      const ctx = await loadFixture(submittedFixture);
      const submittedAt = (await ctx.escrow.jobs(1n)).submittedAt;
      await time.increaseTo(submittedAt + REVIEW + 20n);
      await (await ctx.escrow.connect(ctx.client).approveAndPay(1n)).wait();
      expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Completed);
    });
  });

  describe("revision requests", function () {
    it("sends submitted work back to Created with a note and an extended deadline", async function () {
      const ctx = await loadFixture(submittedFixture);
      const tx = await ctx.escrow.connect(ctx.client).requestRevision(1n, "Please fix the footer");
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const job = await ctx.escrow.jobs(1n);
      expect(job.status).to.equal(Status.Created);
      expect(job.revisions).to.equal(1n);
      expect(job.submittedAt).to.equal(0n);
      expect(job.deadline).to.be.greaterThanOrEqual(BigInt(block.timestamp) + REVISION_PERIOD);
      expect(await ctx.escrow.revisionNotes(1n)).to.equal("Please fix the footer");
      expect(await contractBalance(ctx)).to.equal(ETH);
      await expect(tx).to.emit(ctx.escrow, "RevisionRequested").withArgs(1n, 1n, "Please fix the footer", job.deadline);
    });

    it("keeps the original deadline when it is already later than the revision period", async function () {
      const ctx = await loadFixture(deployFixture);
      await createJob(ctx, { duration: 30n });
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "v1")).wait();
      const original = (await ctx.escrow.jobs(1n)).deadline;
      await (await ctx.escrow.connect(ctx.client).requestRevision(1n, "tweak")).wait();
      expect((await ctx.escrow.jobs(1n)).deadline).to.equal(original);
    });

    it("lets the freelancer resubmit and the client approve afterwards", async function () {
      const ctx = await loadFixture(submittedFixture);
      await (await ctx.escrow.connect(ctx.client).requestRevision(1n, "fix it")).wait();
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "v2")).wait();
      const job = await ctx.escrow.jobs(1n);
      expect(job.status).to.equal(Status.Submitted);
      expect(job.workHash).to.equal("v2");
      await (await ctx.escrow.connect(ctx.client).approveAndPay(1n)).wait();
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH);
    });

    it("allows at most MAX_REVISIONS requests", async function () {
      const ctx = await loadFixture(submittedFixture);
      for (let i = 1n; i <= MAX_REVISIONS; i++) {
        await (await ctx.escrow.connect(ctx.client).requestRevision(1n, `round ${i}`)).wait();
        await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, `v${i + 1n}`)).wait();
      }
      await expect(ctx.escrow.connect(ctx.client).requestRevision(1n, "one more"))
        .to.be.revertedWith("No revisions left");
      // The client can still approve or dispute.
      await (await ctx.escrow.connect(ctx.client).approveAndPay(1n)).wait();
    });

    it("is client-only and needs submitted work", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.client).requestRevision(1n, "x"))
        .to.be.revertedWith("Work not submitted");
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "proof")).wait();
      for (const signer of [ctx.freelancer, ctx.outsider, ctx.arbiter]) {
        await expect(ctx.escrow.connect(signer).requestRevision(1n, "x"))
          .to.be.revertedWith("Only client");
      }
    });

    it("requires a non-empty note of at most 500 bytes", async function () {
      const ctx = await loadFixture(submittedFixture);
      await expect(ctx.escrow.connect(ctx.client).requestRevision(1n, ""))
        .to.be.revertedWith("Note is required");
      await expect(ctx.escrow.connect(ctx.client).requestRevision(1n, "a".repeat(501)))
        .to.be.revertedWith("Note too long");
      await (await ctx.escrow.connect(ctx.client).requestRevision(1n, "a".repeat(500))).wait();
    });

    it("is only possible while the review period is running", async function () {
      const ctx = await loadFixture(submittedFixture);
      const submittedAt = (await ctx.escrow.jobs(1n)).submittedAt;
      await time.increaseTo(submittedAt + REVIEW + 1n);
      await expect(ctx.escrow.connect(ctx.client).requestRevision(1n, "too late"))
        .to.be.revertedWith("Review period over");
    });

    it("lets the client cancel after the (extended) deadline if the freelancer never resubmits", async function () {
      const ctx = await loadFixture(submittedFixture);
      await (await ctx.escrow.connect(ctx.client).requestRevision(1n, "fix")).wait();
      const deadline = (await ctx.escrow.jobs(1n)).deadline;
      await expect(ctx.escrow.connect(ctx.client).cancelTimeout(1n)).to.be.revertedWith("Deadline not passed");
      await time.increaseTo(deadline + 1n);
      await (await ctx.escrow.connect(ctx.client).cancelTimeout(1n)).wait();
      expect(await ctx.escrow.balances(ctx.client.address)).to.equal(ETH);
    });

    it("blocks the freelancer's timeout claim while changes are pending", async function () {
      const ctx = await loadFixture(submittedFixture);
      await (await ctx.escrow.connect(ctx.client).requestRevision(1n, "fix")).wait();
      await time.increase(REVIEW + 1n);
      await expect(ctx.escrow.connect(ctx.freelancer).claimTimeout(1n))
        .to.be.revertedWith("Work not submitted");
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
      expect(await ctx.escrow.balances(ctx.client.address)).to.equal(ETH);
      expect(await withdrawAndMeasure(ctx, ctx.client)).to.equal(ETH);
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
      expect(await ctx.escrow.balances(ctx.client.address)).to.equal(ETH);
    });
  });

  describe("mutual cancellation", function () {
    it("cancels and refunds the client when the freelancer accepts the client's request", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.client).requestCancel(1n))
        .to.emit(ctx.escrow, "CancelRequested").withArgs(1n, ctx.client.address);
      expect((await ctx.escrow.jobs(1n)).cancelRequestedBy).to.equal(ctx.client.address);
      await expect(ctx.escrow.connect(ctx.freelancer).acceptCancel(1n))
        .to.emit(ctx.escrow, "JobCancelled").withArgs(1n);
      const job = await ctx.escrow.jobs(1n);
      expect(job.status).to.equal(Status.Cancelled);
      expect(job.cancelRequestedBy).to.equal(ethers.ZeroAddress);
      expect(await ctx.escrow.balances(ctx.client.address)).to.equal(ETH);
      expect(await withdrawAndMeasure(ctx, ctx.client)).to.equal(ETH);
    });

    it("also works when the freelancer asks and the client accepts, before the deadline", async function () {
      const ctx = await loadFixture(createdFixture);
      await (await ctx.escrow.connect(ctx.freelancer).requestCancel(1n)).wait();
      await (await ctx.escrow.connect(ctx.client).acceptCancel(1n)).wait();
      expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Cancelled);
      expect(await ctx.escrow.balances(ctx.client.address)).to.equal(ETH);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(0n);
    });

    it("cannot be accepted by the requester, outsiders, or without a request", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.freelancer).acceptCancel(1n)).to.be.revertedWith("No cancel request");
      await (await ctx.escrow.connect(ctx.client).requestCancel(1n)).wait();
      await expect(ctx.escrow.connect(ctx.client).acceptCancel(1n)).to.be.revertedWith("Counterparty must accept");
      await expect(ctx.escrow.connect(ctx.outsider).acceptCancel(1n)).to.be.revertedWith("Only job parties");
    });

    it("rejects outsiders and duplicate requests", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.outsider).requestCancel(1n)).to.be.revertedWith("Only job parties");
      await (await ctx.escrow.connect(ctx.client).requestCancel(1n)).wait();
      await expect(ctx.escrow.connect(ctx.freelancer).requestCancel(1n)).to.be.revertedWith("Cancel already requested");
    });

    it("lets only the requester withdraw the request, after which the other side cannot accept", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.client).withdrawCancelRequest(1n)).to.be.revertedWith("No cancel request");
      await (await ctx.escrow.connect(ctx.client).requestCancel(1n)).wait();
      await expect(ctx.escrow.connect(ctx.freelancer).withdrawCancelRequest(1n)).to.be.revertedWith("Not your request");
      await expect(ctx.escrow.connect(ctx.client).withdrawCancelRequest(1n))
        .to.emit(ctx.escrow, "CancelRequestWithdrawn").withArgs(1n, ctx.client.address);
      await expect(ctx.escrow.connect(ctx.freelancer).acceptCancel(1n)).to.be.revertedWith("No cancel request");
      // A fresh request is possible again.
      await (await ctx.escrow.connect(ctx.freelancer).requestCancel(1n)).wait();
    });

    it("is void once work is submitted or a dispute is raised", async function () {
      const ctx = await loadFixture(createdFixture);
      await (await ctx.escrow.connect(ctx.client).requestCancel(1n)).wait();
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "proof")).wait();
      expect((await ctx.escrow.jobs(1n)).cancelRequestedBy).to.equal(ethers.ZeroAddress);
      await expect(ctx.escrow.connect(ctx.freelancer).acceptCancel(1n)).to.be.revertedWith("Job is not open");
      await expect(ctx.escrow.connect(ctx.client).requestCancel(1n)).to.be.revertedWith("Job is not open");

      const second = await loadFixture(createdFixture);
      await (await second.escrow.connect(second.client).requestCancel(1n)).wait();
      await (await second.escrow.connect(second.freelancer).raiseDispute(1n)).wait();
      expect((await second.escrow.jobs(1n)).cancelRequestedBy).to.equal(ethers.ZeroAddress);
    });

    it("cannot be repeated after the job is cancelled", async function () {
      const ctx = await loadFixture(createdFixture);
      await (await ctx.escrow.connect(ctx.client).requestCancel(1n)).wait();
      await (await ctx.escrow.connect(ctx.freelancer).acceptCancel(1n)).wait();
      await expect(ctx.escrow.connect(ctx.freelancer).acceptCancel(1n)).to.be.revertedWith("Job is not open");
      expect(await ctx.escrow.balances(ctx.client.address)).to.equal(ETH);
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
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH);
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
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH);
    });
  });

  describe("disputes and arbitration", function () {
    it("allows either party to dispute an open or submitted job and records the time", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.freelancer).raiseDispute(1n))
        .to.emit(ctx.escrow, "DisputeRaised").withArgs(1n, ctx.freelancer.address);
      const job = await ctx.escrow.jobs(1n);
      expect(job.status).to.equal(Status.Disputed);
      expect(job.disputedAt).to.be.greaterThan(0n);
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
        await expect(ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, percent))
          .to.emit(ctx.escrow, "JobCompleted").withArgs(1n, freelancerAmount, clientAmount);
        expect(await ctx.escrow.balances(ctx.client.address)).to.equal(clientAmount);
        expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(freelancerAmount);
        expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Completed);
        if (clientAmount > 0n) expect(await withdrawAndMeasure(ctx, ctx.client)).to.equal(clientAmount);
        if (freelancerAmount > 0n) expect(await withdrawAndMeasure(ctx, ctx.freelancer)).to.equal(freelancerAmount);
        expect(await contractBalance(ctx)).to.equal(0n);
      });
    }

    it("assigns fractional wei rounding remainder to the client", async function () {
      const ctx = await loadFixture(deployFixture);
      await createJob(ctx, { amount: 101n });
      await (await ctx.escrow.connect(ctx.client).raiseDispute(1n)).wait();
      await expect(ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, 50n))
        .to.emit(ctx.escrow, "JobCompleted").withArgs(1n, 50n, 51n);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(50n);
      expect(await ctx.escrow.balances(ctx.client.address)).to.equal(51n);
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

  describe("arbiter timeout", function () {
    it("splits 50/50 when the arbiter stays silent for more than ARBITER_TIMEOUT", async function () {
      const ctx = await loadFixture(disputedFixture);
      const disputedAt = (await ctx.escrow.jobs(1n)).disputedAt;
      await expect(ctx.escrow.connect(ctx.freelancer).claimDisputeTimeout(1n))
        .to.be.revertedWith("Arbiter still has time");
      await time.increaseTo(disputedAt + ARBITER_TIMEOUT);
      await expect(ctx.escrow.connect(ctx.client).claimDisputeTimeout.staticCall(1n))
        .to.be.revertedWith("Arbiter still has time");
      await time.increase(1);
      const tx = ctx.escrow.connect(ctx.client).claimDisputeTimeout(1n);
      await expect(tx).to.emit(ctx.escrow, "DisputeTimedOut").withArgs(1n, ctx.client.address);
      await expect(tx).to.emit(ctx.escrow, "JobCompleted").withArgs(1n, ETH / 2n, ETH / 2n);
      expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Completed);
      expect(await withdrawAndMeasure(ctx, ctx.client)).to.equal(ETH / 2n);
      expect(await withdrawAndMeasure(ctx, ctx.freelancer)).to.equal(ETH / 2n);
      expect(await contractBalance(ctx)).to.equal(0n);
    });

    it("gives the odd wei of a 50/50 split to the client", async function () {
      const ctx = await loadFixture(deployFixture);
      await createJob(ctx, { amount: 101n });
      await (await ctx.escrow.connect(ctx.freelancer).raiseDispute(1n)).wait();
      await time.increase(ARBITER_TIMEOUT + 1n);
      await (await ctx.escrow.connect(ctx.freelancer).claimDisputeTimeout(1n)).wait();
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(50n);
      expect(await ctx.escrow.balances(ctx.client.address)).to.equal(51n);
    });

    it("is limited to the job's parties and disputed jobs", async function () {
      const ctx = await loadFixture(submittedFixture);
      await expect(ctx.escrow.connect(ctx.client).claimDisputeTimeout(1n))
        .to.be.revertedWith("Job is not disputed");
      await (await ctx.escrow.connect(ctx.client).raiseDispute(1n)).wait();
      await time.increase(ARBITER_TIMEOUT + 1n);
      for (const signer of [ctx.outsider, ctx.arbiter]) {
        await expect(ctx.escrow.connect(signer).claimDisputeTimeout(1n))
          .to.be.revertedWith("Only job parties");
      }
    });

    it("lets the arbiter still decide before anyone forces the timeout", async function () {
      const ctx = await loadFixture(disputedFixture);
      await time.increase(ARBITER_TIMEOUT + 1n);
      await (await ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, 100n)).wait();
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH);
    });

    it("is terminal: neither the timeout nor the arbiter can settle twice", async function () {
      const ctx = await loadFixture(disputedFixture);
      await time.increase(ARBITER_TIMEOUT + 1n);
      await (await ctx.escrow.connect(ctx.client).claimDisputeTimeout(1n)).wait();
      await expect(ctx.escrow.connect(ctx.freelancer).claimDisputeTimeout(1n))
        .to.be.revertedWith("Job is not disputed");
      await expect(ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, 100n))
        .to.be.revertedWith("Job is not disputed");
    });
  });

  describe("pull payments", function () {
    it("rejects withdrawals when nothing is owed", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.freelancer).withdraw()).to.be.revertedWith("Nothing to withdraw");
    });

    it("emits Withdrawn, zeroes the balance, and cannot be drained twice", async function () {
      const ctx = await loadFixture(submittedFixture);
      await (await ctx.escrow.connect(ctx.client).approveAndPay(1n)).wait();
      await expect(ctx.escrow.connect(ctx.freelancer).withdraw())
        .to.emit(ctx.escrow, "Withdrawn").withArgs(ctx.freelancer.address, ETH);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(0n);
      await expect(ctx.escrow.connect(ctx.freelancer).withdraw()).to.be.revertedWith("Nothing to withdraw");
    });

    it("accumulates credits from several jobs into one withdrawal", async function () {
      const ctx = await loadFixture(deployFixture);
      await createJob(ctx);
      await createJob(ctx, { amount: ethers.parseEther("0.5") });
      for (const id of [1n, 2n]) {
        await (await ctx.escrow.connect(ctx.freelancer).submitWork(id, "proof")).wait();
        await (await ctx.escrow.connect(ctx.client).approveAndPay(id)).wait();
      }
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ethers.parseEther("1.5"));
      expect(await withdrawAndMeasure(ctx, ctx.freelancer)).to.equal(ethers.parseEther("1.5"));
    });

    it("only releases a user's own credit", async function () {
      const ctx = await loadFixture(submittedFixture);
      await (await ctx.escrow.connect(ctx.client).approveAndPay(1n)).wait();
      await expect(ctx.escrow.connect(ctx.outsider).withdraw()).to.be.revertedWith("Nothing to withdraw");
      await expect(ctx.escrow.connect(ctx.client).withdraw()).to.be.revertedWith("Nothing to withdraw");
      expect(await contractBalance(ctx)).to.equal(ETH);
    });
  });

  describe("recipients that reject ETH", function () {
    async function rejectingFreelancer() {
      const ctx = await deployFixture();
      const rejectEther = await ethers.deployContract("RejectEther");
      await rejectEther.waitForDeployment();
      await createJob(ctx, { freelancer: { address: await rejectEther.getAddress() } });
      await (await rejectEther.submit(await ctx.escrow.getAddress(), 1n, "proof")).wait();
      return { ...ctx, rejectEther };
    }

    it("still settles the job; only the rejecting party's own withdrawal fails", async function () {
      const ctx = await loadFixture(rejectingFreelancer);
      await (await ctx.escrow.connect(ctx.client).approveAndPay(1n)).wait();
      expect((await ctx.escrow.jobs(1n)).status).to.equal(Status.Completed);
      const rejecterAddress = await ctx.rejectEther.getAddress();
      expect(await ctx.escrow.balances(rejecterAddress)).to.equal(ETH);
      await expect(ctx.rejectEther.pull(await ctx.escrow.getAddress()))
        .to.be.revertedWith("ETH transfer failed");
      expect(await ctx.escrow.balances(rejecterAddress)).to.equal(ETH);
      expect(await contractBalance(ctx)).to.equal(ETH);
    });

    it("cannot stop the client from receiving their share of a dispute settlement", async function () {
      const ctx = await loadFixture(rejectingFreelancer);
      await (await ctx.escrow.connect(ctx.client).raiseDispute(1n)).wait();
      await (await ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, 50n)).wait();
      expect(await withdrawAndMeasure(ctx, ctx.client)).to.equal(ETH / 2n);
    });

    it("cannot stop a 50/50 arbiter-timeout settlement either", async function () {
      const ctx = await loadFixture(rejectingFreelancer);
      await (await ctx.escrow.connect(ctx.client).raiseDispute(1n)).wait();
      await time.increase(ARBITER_TIMEOUT + 1n);
      await (await ctx.escrow.connect(ctx.client).claimDisputeTimeout(1n)).wait();
      expect(await withdrawAndMeasure(ctx, ctx.client)).to.equal(ETH / 2n);
    });
  });
  describe("50% advance with explicit client approval", function () {
    async function startedFixture() {
      const ctx = await createdFixture();
      await (await ctx.escrow.connect(ctx.freelancer).requestAdvance(1n)).wait();
      await (await ctx.escrow.connect(ctx.client).approveAdvance(1n)).wait();
      return ctx;
    }
    async function sumOfBalances(ctx) {
      let total = 0n;
      for (const signer of [ctx.arbiter, ctx.client, ctx.freelancer, ctx.outsider, ctx.secondClient]) {
        total += await ctx.escrow.balances(signer.address);
      }
      return total;
    }

    it("credits half only after client approval", async function () {
      const ctx = await loadFixture(createdFixture);
      await ctx.escrow.connect(ctx.freelancer).requestAdvance(1n);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(0n);
      await expect(ctx.escrow.connect(ctx.client).approveAdvance(1n))
        .to.emit(ctx.escrow, "JobStarted").withArgs(1n, ctx.freelancer.address, ETH / 2n);
      const job = await ctx.escrow.jobs(1n);
      expect(job.advancePaid).to.equal(ETH / 2n);
      expect(job.status).to.equal(Status.Created);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH / 2n);
      expect(await contractBalance(ctx)).to.equal(ETH); // nothing leaves until withdrawn
      expect(await withdrawAndMeasure(ctx, ctx.freelancer)).to.equal(ETH / 2n);
      expect(await contractBalance(ctx)).to.equal(ETH / 2n); // the other half stays locked
    });

    it("pays the remaining half on approval, so the freelancer gets the full amount in total", async function () {
      const ctx = await loadFixture(startedFixture);
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "proof")).wait();
      await expect(ctx.escrow.connect(ctx.client).approveAndPay(1n))
        .to.emit(ctx.escrow, "JobCompleted").withArgs(1n, ETH / 2n, 0n);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH);
      expect(await withdrawAndMeasure(ctx, ctx.freelancer)).to.equal(ETH);
      expect(await contractBalance(ctx)).to.equal(0n);
    });

    it("pays the remaining half on the freelancer's review timeout", async function () {
      const ctx = await loadFixture(startedFixture);
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "proof")).wait();
      await time.increase(REVIEW + 1n);
      await expect(ctx.escrow.connect(ctx.freelancer).claimTimeout(1n))
        .to.emit(ctx.escrow, "JobCompleted").withArgs(1n, ETH / 2n, 0n);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH);
    });

    it("is optional: skipping it pays the whole amount at the end", async function () {
      const ctx = await loadFixture(submittedFixture);
      await expect(ctx.escrow.connect(ctx.client).approveAndPay(1n))
        .to.emit(ctx.escrow, "JobCompleted").withArgs(1n, ETH, 0n);
      expect((await ctx.escrow.jobs(1n)).advancePaid).to.equal(0n);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH);
    });

    it("gives the odd wei to the final payment", async function () {
      const ctx = await loadFixture(deployFixture);
      await createJob(ctx, { amount: 101n });
      await (await ctx.escrow.connect(ctx.freelancer).requestAdvance(1n)).wait();
      await (await ctx.escrow.connect(ctx.client).approveAdvance(1n)).wait();
      expect((await ctx.escrow.jobs(1n)).advancePaid).to.equal(50n);
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "proof")).wait();
      await expect(ctx.escrow.connect(ctx.client).approveAndPay(1n))
        .to.emit(ctx.escrow, "JobCompleted").withArgs(1n, 51n, 0n);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(101n);
    });

    it("is restricted to the freelancer, to open jobs, before the deadline, and only once", async function () {
      const ctx = await loadFixture(createdFixture);
      for (const signer of [ctx.client, ctx.outsider, ctx.arbiter]) {
        await expect(ctx.escrow.connect(signer).requestAdvance(1n)).to.be.revertedWith("Only freelancer");
      }
      await (await ctx.escrow.connect(ctx.freelancer).requestAdvance(1n)).wait();
      await (await ctx.escrow.connect(ctx.client).approveAdvance(1n)).wait();
      await expect(ctx.escrow.connect(ctx.freelancer).requestAdvance(1n)).to.be.revertedWith("Advance already paid");
      await expect(ctx.escrow.connect(ctx.freelancer).requestAdvance(99n)).to.be.revertedWith("Job does not exist");

      const late = await loadFixture(createdFixture);
      await time.increaseTo((await late.escrow.jobs(1n)).deadline + 1n);
      await expect(late.escrow.connect(late.freelancer).requestAdvance(1n)).to.be.revertedWith("Deadline passed");

      const submitted = await loadFixture(submittedFixture);
      await expect(submitted.escrow.connect(submitted.freelancer).requestAdvance(1n)).to.be.revertedWith("Job is not open");

      const disputed = await loadFixture(disputedFixture);
      await expect(disputed.escrow.connect(disputed.freelancer).requestAdvance(1n)).to.be.revertedWith("Job is not open");
    });

    it("cannot be used to collect an advance after work was already submitted (revision round)", async function () {
      const ctx = await loadFixture(submittedFixture);
      await (await ctx.escrow.connect(ctx.client).requestRevision(1n, "fix")).wait();
      await expect(ctx.escrow.connect(ctx.freelancer).requestAdvance(1n)).to.be.revertedWith("Work already submitted");
    });

    it("is blocked while a cancel request is pending", async function () {
      const ctx = await loadFixture(createdFixture);
      await (await ctx.escrow.connect(ctx.client).requestCancel(1n)).wait();
      await expect(ctx.escrow.connect(ctx.freelancer).requestAdvance(1n)).to.be.revertedWith("Cancel request pending");
    });

    it("rejects deposits too small to split", async function () {
      const ctx = await loadFixture(deployFixture);
      await createJob(ctx, { amount: 1n });
      await expect(ctx.escrow.connect(ctx.freelancer).requestAdvance(1n)).to.be.revertedWith("Deposit too small");
    });

    it("refunds only the unadvanced half on mutual cancellation", async function () {
      const ctx = await loadFixture(startedFixture);
      await (await ctx.escrow.connect(ctx.client).requestCancel(1n)).wait();
      await (await ctx.escrow.connect(ctx.freelancer).acceptCancel(1n)).wait();
      expect(await ctx.escrow.balances(ctx.client.address)).to.equal(ETH / 2n);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH / 2n);
      expect(await sumOfBalances(ctx)).to.equal(await contractBalance(ctx));
    });

    it("refunds only the unadvanced half when the client cancels after the deadline", async function () {
      const ctx = await loadFixture(startedFixture);
      await time.increaseTo((await ctx.escrow.jobs(1n)).deadline + 1n);
      await (await ctx.escrow.connect(ctx.client).cancelTimeout(1n)).wait();
      expect(await ctx.escrow.balances(ctx.client.address)).to.equal(ETH / 2n);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH / 2n);
    });

    it("splits only the remaining half in a dispute (freelancer keeps the advance)", async function () {
      const ctx = await loadFixture(startedFixture);
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "proof")).wait();
      await (await ctx.escrow.connect(ctx.client).raiseDispute(1n)).wait();
      await expect(ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, 50n))
        .to.emit(ctx.escrow, "JobCompleted").withArgs(1n, ETH / 4n, ETH / 4n);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH / 2n + ETH / 4n);
      expect(await ctx.escrow.balances(ctx.client.address)).to.equal(ETH / 4n);
      expect(await sumOfBalances(ctx)).to.equal(await contractBalance(ctx));
    });

    it("lets the arbiter award 0% and refunds the client the whole remaining half", async function () {
      const ctx = await loadFixture(startedFixture);
      await (await ctx.escrow.connect(ctx.client).raiseDispute(1n)).wait();
      await (await ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, 0n)).wait();
      expect(await ctx.escrow.balances(ctx.client.address)).to.equal(ETH / 2n);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH / 2n);
    });

    it("splits only the remaining half on arbiter timeout", async function () {
      const ctx = await loadFixture(startedFixture);
      await (await ctx.escrow.connect(ctx.client).raiseDispute(1n)).wait();
      await time.increase(ARBITER_TIMEOUT + 1n);
      await expect(ctx.escrow.connect(ctx.client).claimDisputeTimeout(1n))
        .to.emit(ctx.escrow, "JobCompleted").withArgs(1n, ETH / 4n, ETH / 4n);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(ETH / 2n + ETH / 4n);
      expect(await ctx.escrow.balances(ctx.client.address)).to.equal(ETH / 4n);
    });

    it("never lets the contract owe more than it holds", async function () {
      const ctx = await loadFixture(deployFixture);
      await createJob(ctx);
      await createJob(ctx, { amount: 333n });
      for (const id of [1n, 2n]) {
        await ctx.escrow.connect(ctx.freelancer).requestAdvance(id);
        await ctx.escrow.connect(ctx.client).approveAdvance(id);
      }
      expect(await sumOfBalances(ctx)).to.be.lessThanOrEqual(await contractBalance(ctx));
      await (await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "p")).wait();
      await (await ctx.escrow.connect(ctx.client).approveAndPay(1n)).wait();
      await (await ctx.escrow.connect(ctx.client).raiseDispute(2n)).wait();
      await (await ctx.escrow.connect(ctx.arbiter).resolveDispute(2n, 33n)).wait();
      expect(await sumOfBalances(ctx)).to.equal(await contractBalance(ctx)); // every job settled
      await withdrawAndMeasure(ctx, ctx.freelancer);
      await withdrawAndMeasure(ctx, ctx.client);
      expect(await contractBalance(ctx)).to.equal(0n);
    });
  });
  describe("Advance approval security and request lifecycle", function () {
    it("does not credit a request, rejects duplicates, and only the client can approve/reject", async function () {
      const ctx = await loadFixture(createdFixture);
      await expect(ctx.escrow.connect(ctx.client).approveAdvance(1n)).to.be.revertedWith("No advance request");
      await expect(ctx.escrow.connect(ctx.client).rejectAdvance(1n)).to.be.revertedWith("No advance request");
      await expect(ctx.escrow.connect(ctx.freelancer).requestAdvance(1n))
        .to.emit(ctx.escrow, "AdvanceRequested").withArgs(1n, ctx.freelancer.address);
      expect(await ctx.escrow.advanceRequested(1n)).to.equal(true);
      expect((await ctx.escrow.jobs(1n)).advancePaid).to.equal(0n);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(0n);
      await expect(ctx.escrow.connect(ctx.freelancer).withdraw()).to.be.revertedWith("Nothing to withdraw");
      await expect(ctx.escrow.connect(ctx.freelancer).requestAdvance(1n)).to.be.revertedWith("Advance already requested");
      for (const signer of [ctx.freelancer, ctx.arbiter, ctx.outsider, ctx.secondClient]) {
        for (const method of ["approveAdvance", "rejectAdvance"]) {
          await expect(ctx.escrow.connect(signer)[method](1n)).to.be.revertedWith("Only client");
        }
      }
      await expect(ctx.escrow.connect(ctx.client).approveAdvance(1n))
        .to.emit(ctx.escrow, "AdvanceApproved").withArgs(1n, ctx.client.address, ETH / 2n);
      expect(await ctx.escrow.advanceRequested(1n)).to.equal(false);
      await expect(ctx.escrow.connect(ctx.client).approveAdvance(1n)).to.be.revertedWith("Advance already paid");
    });

    it("rejects without moving funds and permits a fresh request", async function () {
      const ctx = await loadFixture(createdFixture);
      await ctx.escrow.connect(ctx.freelancer).requestAdvance(1n);
      await expect(ctx.escrow.connect(ctx.client).rejectAdvance(1n))
        .to.emit(ctx.escrow, "AdvanceRejected").withArgs(1n, ctx.client.address);
      expect(await ctx.escrow.advanceRequested(1n)).to.equal(false);
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(0n);
      expect(await contractBalance(ctx)).to.equal(ETH);
      await expect(ctx.escrow.connect(ctx.client).approveAdvance(1n)).to.be.revertedWith("No advance request");
      await ctx.escrow.connect(ctx.freelancer).requestAdvance(1n);
      await ctx.escrow.connect(ctx.client).approveAdvance(1n);
      expect(await withdrawAndMeasure(ctx, ctx.freelancer)).to.equal(ETH / 2n);
    });

    it("does not auto-approve and cannot be approved after the deadline", async function () {
      const ctx = await loadFixture(createdFixture);
      await ctx.escrow.connect(ctx.freelancer).requestAdvance(1n);
      await time.increaseTo((await ctx.escrow.jobs(1n)).deadline + 1n);
      await expect(ctx.escrow.connect(ctx.client).approveAdvance(1n)).to.be.revertedWith("Deadline passed");
      expect(await ctx.escrow.balances(ctx.freelancer.address)).to.equal(0n);
      await ctx.escrow.connect(ctx.client).cancelTimeout(1n);
      expect(await ctx.escrow.advanceRequested(1n)).to.equal(false);
      expect(await withdrawAndMeasure(ctx, ctx.client)).to.equal(ETH);
    });

    it("clears on submission and never revives during revisions; pays full amount", async function () {
      const ctx = await loadFixture(createdFixture);
      await ctx.escrow.connect(ctx.freelancer).requestAdvance(1n);
      await expect(ctx.escrow.connect(ctx.freelancer).submitWork(1n, "proof"))
        .to.emit(ctx.escrow, "AdvanceRequestCleared").withArgs(1n);
      expect(await ctx.escrow.advanceRequested(1n)).to.equal(false);
      await expect(ctx.escrow.connect(ctx.client).approveAdvance(1n)).to.be.revertedWith("Job is not open");
      await ctx.escrow.connect(ctx.client).requestRevision(1n, "fix");
      await expect(ctx.escrow.connect(ctx.client).approveAdvance(1n)).to.be.revertedWith("Work already submitted");
      await ctx.escrow.connect(ctx.freelancer).submitWork(1n, "fixed");
      await ctx.escrow.connect(ctx.client).approveAndPay(1n);
      expect(await withdrawAndMeasure(ctx, ctx.freelancer)).to.equal(ETH);
    });

    for (const role of ["client", "freelancer"]) {
      it(`clears on ${role} cancellation request, including after withdrawal of cancellation`, async function () {
        const ctx = await loadFixture(createdFixture);
        await ctx.escrow.connect(ctx.freelancer).requestAdvance(1n);
        await ctx.escrow.connect(ctx[role]).requestCancel(1n);
        expect(await ctx.escrow.advanceRequested(1n)).to.equal(false);
        await expect(ctx.escrow.connect(ctx.client).approveAdvance(1n)).to.be.revertedWith("Cancel request pending");
        await ctx.escrow.connect(ctx[role]).withdrawCancelRequest(1n);
        await expect(ctx.escrow.connect(ctx.client).approveAdvance(1n)).to.be.revertedWith("No advance request");
        await ctx.escrow.connect(ctx.freelancer).requestAdvance(1n);
        await ctx.escrow.connect(ctx[role]).requestCancel(1n);
        await ctx.escrow.connect(ctx[role === "client" ? "freelancer" : "client"]).acceptCancel(1n);
        expect(await withdrawAndMeasure(ctx, ctx.client)).to.equal(ETH);
      });
      it(`clears when ${role} raises a dispute`, async function () {
        const ctx = await loadFixture(createdFixture);
        await ctx.escrow.connect(ctx.freelancer).requestAdvance(1n);
        await ctx.escrow.connect(ctx[role]).raiseDispute(1n);
        expect(await ctx.escrow.advanceRequested(1n)).to.equal(false);
        await expect(ctx.escrow.connect(ctx.client).approveAdvance(1n)).to.be.revertedWith("Job is not open");
        await ctx.escrow.connect(ctx.arbiter).resolveDispute(1n, 0n);
        expect(await withdrawAndMeasure(ctx, ctx.client)).to.equal(ETH);
      });
    }
  });

});
