// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title FreelanceEscrow
/// @notice Holds each job's ETH until approval, timeout, mutual cancellation or arbitration.
/// @dev A freelancer may request a 50% advance; only the client can approve it; every later payout or refund applies
///      to the remaining part of the deposit only. Payouts use the pull-payment pattern: settlements credit `balances`, and each
///      recipient collects with `withdraw()`. A recipient that rejects ETH can therefore
///      never block a settlement that also pays somebody else.
contract FreelanceEscrow {
    enum JobStatus { Created, Submitted, Completed, Disputed, Cancelled }

    struct Job {
        uint256 id;
        address client;
        address freelancer;
        string title;
        uint256 amount;
        string workHash;
        uint256 deadline;
        uint256 submittedAt;
        JobStatus status;
        uint8 revisions;          // how many times the client has asked for changes
        uint256 disputedAt;       // timestamp the dispute was raised (0 if never)
        address cancelRequestedBy; // party asking for a mutual cancel (0 if none)
        uint256 advancePaid;      // part of `amount` already credited to the freelancer after client approval
    }

    address public immutable arbiter;

    /// @notice Time the client has to review submitted work before the freelancer may claim payment.
    uint256 public constant REVIEW_PERIOD = 3 days;
    /// @notice Maximum number of revision requests per job.
    uint8 public constant MAX_REVISIONS = 2;
    /// @notice Minimum time the freelancer gets after a revision request.
    uint256 public constant REVISION_PERIOD = 3 days;
    /// @notice After this long without an arbiter decision, either party can force a 50/50 split.
    uint256 public constant ARBITER_TIMEOUT = 7 days;
    uint256 public constant MAX_NOTE_LENGTH = 500;
    /// @notice Share of the deposit the freelancer receives up front after client approval.
    uint256 public constant ADVANCE_PERCENT = 50;

    mapping(uint256 => Job) public jobs;
    mapping(uint256 => bool) public advanceRequested;
    mapping(uint256 => string) public revisionNotes;
    /// @notice ETH credited to an address and not yet withdrawn.
    mapping(address => uint256) public balances;
    uint256 public jobCounter;

    mapping(address => uint256[]) private _userJobs;

    event JobCreated(uint256 indexed jobId, address indexed client, address indexed freelancer, uint256 amount, uint256 deadline);
    event AdvanceRequested(uint256 indexed jobId, address indexed freelancer);
    event AdvanceApproved(uint256 indexed jobId, address indexed client, uint256 amount);
    event AdvanceRejected(uint256 indexed jobId, address indexed client);
    event AdvanceRequestCleared(uint256 indexed jobId);
    // Kept for transaction-history readers; emitted only after client approval.
    event JobStarted(uint256 indexed jobId, address indexed freelancer, uint256 advance);
    event WorkSubmitted(uint256 indexed jobId, string workHash, uint256 submittedAt);
    event RevisionRequested(uint256 indexed jobId, uint8 revisionNumber, string note, uint256 newDeadline);
    event JobCompleted(uint256 indexed jobId, uint256 freelancerAmount, uint256 clientAmount);
    event JobCancelled(uint256 indexed jobId);
    event CancelRequested(uint256 indexed jobId, address indexed requestedBy);
    event CancelRequestWithdrawn(uint256 indexed jobId, address indexed requestedBy);
    event DisputeRaised(uint256 indexed jobId, address indexed raisedBy);
    event DisputeTimedOut(uint256 indexed jobId, address indexed triggeredBy);
    event Withdrawn(address indexed to, uint256 amount);

    constructor() { arbiter = msg.sender; }

    modifier existingJob(uint256 jobId) {
        require(jobId > 0 && jobId <= jobCounter, "Job does not exist");
        _;
    }

    // ---------------------------------------------------------------- creation

    function createJob(address freelancer, string calldata title, uint256 durationDays)
        external payable returns (uint256)
    {
        require(msg.value > 0, "Deposit must be positive");
        require(freelancer != address(0) && freelancer != msg.sender, "Invalid freelancer");
        require(bytes(title).length > 0, "Title is required");
        require(durationDays > 0, "Duration must be positive");
        uint256 id = ++jobCounter;
        uint256 deadline = block.timestamp + durationDays * 1 days;
        jobs[id] = Job({
            id: id,
            client: msg.sender,
            freelancer: freelancer,
            title: title,
            amount: msg.value,
            workHash: "",
            deadline: deadline,
            submittedAt: 0,
            status: JobStatus.Created,
            revisions: 0,
            disputedAt: 0,
            cancelRequestedBy: address(0),
            advancePaid: 0
        });
        _userJobs[msg.sender].push(id);
        _userJobs[freelancer].push(id);
        emit JobCreated(id, msg.sender, freelancer, msg.value, deadline);
        return id;
    }

    // ---------------------------------------------------------- advance approval

    /// @notice Request an optional advance. This does not credit or transfer ETH.
    function requestAdvance(uint256 jobId) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(msg.sender == job.freelancer, "Only freelancer");
        _checkAdvance(job);
        require(!advanceRequested[jobId], "Advance already requested");
        advanceRequested[jobId] = true;
        emit AdvanceRequested(jobId, msg.sender);
    }

    /// @notice Only the job's client can authorize the advance; withdraw separately.
    function approveAdvance(uint256 jobId) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(msg.sender == job.client, "Only client");
        _checkAdvance(job);
        require(advanceRequested[jobId], "No advance request");
        advanceRequested[jobId] = false;
        uint256 advance = job.amount / 2;
        job.advancePaid = advance;
        _credit(job.freelancer, advance);
        emit AdvanceApproved(jobId, msg.sender, advance);
        emit JobStarted(jobId, job.freelancer, advance);
    }

    /// @notice Reject a pending request without moving funds. A new request is allowed.
    function rejectAdvance(uint256 jobId) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(msg.sender == job.client, "Only client");
        require(job.status == JobStatus.Created, "Job is not open");
        require(advanceRequested[jobId], "No advance request");
        advanceRequested[jobId] = false;
        emit AdvanceRejected(jobId, msg.sender);
    }

    function _checkAdvance(Job storage job) private view {
        require(job.status == JobStatus.Created, "Job is not open");
        require(block.timestamp <= job.deadline, "Deadline passed");
        require(job.advancePaid == 0, "Advance already paid");
        require(bytes(job.workHash).length == 0, "Work already submitted");
        require(job.cancelRequestedBy == address(0), "Cancel request pending");
        require(job.amount / 2 > 0, "Deposit too small");
    }

    function _clearAdvanceRequest(uint256 jobId) private {
        if (advanceRequested[jobId]) {
            advanceRequested[jobId] = false;
            emit AdvanceRequestCleared(jobId);
        }
    }

    // ---------------------------------------------------------- delivery & review

    function submitWork(uint256 jobId, string calldata workHash) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(msg.sender == job.freelancer, "Only freelancer");
        require(job.status == JobStatus.Created, "Job is not open");
        require(block.timestamp <= job.deadline, "Deadline passed");
        require(bytes(workHash).length > 0, "Proof is required");
        _clearAdvanceRequest(jobId);
        job.workHash = workHash;
        job.submittedAt = block.timestamp;
        job.status = JobStatus.Submitted;
        job.cancelRequestedBy = address(0); // delivering work voids any pending cancel request
        emit WorkSubmitted(jobId, workHash, block.timestamp);
    }

    function approveAndPay(uint256 jobId) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(msg.sender == job.client, "Only client");
        require(job.status == JobStatus.Submitted, "Work not submitted");
        job.status = JobStatus.Completed;
        uint256 payout = job.amount - job.advancePaid;
        emit JobCompleted(jobId, payout, 0);
        _credit(job.freelancer, payout);
    }

    /// @notice Client sends submitted work back for changes. The job returns to `Created`
    ///         and the freelancer gets at least REVISION_PERIOD to resubmit.
    function requestRevision(uint256 jobId, string calldata note) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(msg.sender == job.client, "Only client");
        require(job.status == JobStatus.Submitted, "Work not submitted");
        require(block.timestamp <= job.submittedAt + REVIEW_PERIOD, "Review period over");
        require(job.revisions < MAX_REVISIONS, "No revisions left");
        uint256 noteLength = bytes(note).length;
        require(noteLength > 0, "Note is required");
        require(noteLength <= MAX_NOTE_LENGTH, "Note too long");

        job.revisions += 1;
        job.status = JobStatus.Created;
        job.submittedAt = 0;
        uint256 minimumDeadline = block.timestamp + REVISION_PERIOD;
        if (job.deadline < minimumDeadline) job.deadline = minimumDeadline;
        revisionNotes[jobId] = note;
        emit RevisionRequested(jobId, job.revisions, note, job.deadline);
    }

    function claimTimeout(uint256 jobId) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(msg.sender == job.freelancer, "Only freelancer");
        require(job.status == JobStatus.Submitted, "Work not submitted");
        require(block.timestamp > job.submittedAt + REVIEW_PERIOD, "Review period not over");
        job.status = JobStatus.Completed;
        uint256 payout = job.amount - job.advancePaid;
        emit JobCompleted(jobId, payout, 0);
        _credit(job.freelancer, payout);
    }

    // ------------------------------------------------------------- cancellation

    function cancelTimeout(uint256 jobId) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(msg.sender == job.client, "Only client");
        require(job.status == JobStatus.Created, "Job is not open");
        require(block.timestamp > job.deadline, "Deadline not passed");
        _cancel(jobId, job);
    }

    /// @notice Either party proposes cancelling an unsubmitted job; the other must accept.
    function requestCancel(uint256 jobId) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(msg.sender == job.client || msg.sender == job.freelancer, "Only job parties");
        require(job.status == JobStatus.Created, "Job is not open");
        require(job.cancelRequestedBy == address(0), "Cancel already requested");
        _clearAdvanceRequest(jobId);
        job.cancelRequestedBy = msg.sender;
        emit CancelRequested(jobId, msg.sender);
    }

    function withdrawCancelRequest(uint256 jobId) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(job.cancelRequestedBy != address(0), "No cancel request");
        require(msg.sender == job.cancelRequestedBy, "Not your request");
        job.cancelRequestedBy = address(0);
        emit CancelRequestWithdrawn(jobId, msg.sender);
    }

    /// @notice The counterparty accepts a pending cancel request; the client is refunded.
    function acceptCancel(uint256 jobId) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(msg.sender == job.client || msg.sender == job.freelancer, "Only job parties");
        require(job.status == JobStatus.Created, "Job is not open");
        require(job.cancelRequestedBy != address(0), "No cancel request");
        require(job.cancelRequestedBy != msg.sender, "Counterparty must accept");
        _cancel(jobId, job);
    }

    // ----------------------------------------------------------------- disputes

    function raiseDispute(uint256 jobId) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(msg.sender == job.client || msg.sender == job.freelancer, "Only job parties");
        require(job.status == JobStatus.Created || job.status == JobStatus.Submitted, "Cannot dispute this job");
        _clearAdvanceRequest(jobId);
        job.status = JobStatus.Disputed;
        job.disputedAt = block.timestamp;
        job.cancelRequestedBy = address(0);
        emit DisputeRaised(jobId, msg.sender);
    }

    /// @dev A resolved dispute is terminal and recorded as Completed, even if the client receives a refund.
    /// The event records the actual split. Integer rounding remainder goes to the client.
    function resolveDispute(uint256 jobId, uint256 freelancerPercent) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(msg.sender == arbiter, "Only arbiter");
        require(job.status == JobStatus.Disputed, "Job is not disputed");
        require(freelancerPercent <= 100, "Percent exceeds 100");
        _settleDispute(jobId, job, freelancerPercent);
    }

    /// @notice Safety valve: if the arbiter has not decided within ARBITER_TIMEOUT, either
    ///         party can force a 50/50 split so funds are never locked forever.
    function claimDisputeTimeout(uint256 jobId) external existingJob(jobId) {
        Job storage job = jobs[jobId];
        require(msg.sender == job.client || msg.sender == job.freelancer, "Only job parties");
        require(job.status == JobStatus.Disputed, "Job is not disputed");
        require(block.timestamp > job.disputedAt + ARBITER_TIMEOUT, "Arbiter still has time");
        emit DisputeTimedOut(jobId, msg.sender);
        _settleDispute(jobId, job, 50);
    }

    // --------------------------------------------------------------- withdrawals

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        balances[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    // -------------------------------------------------------------------- views

    /// @notice IDs of every job where `user` is the client or the freelancer.
    function getUserJobs(address user) external view returns (uint256[] memory) {
        return _userJobs[user];
    }

    // ---------------------------------------------------------------- internals

    function _cancel(uint256 jobId, Job storage job) private {
        _clearAdvanceRequest(jobId);
        job.status = JobStatus.Cancelled;
        job.cancelRequestedBy = address(0);
        emit JobCancelled(jobId);
        _credit(job.client, job.amount - job.advancePaid);
    }

    function _settleDispute(uint256 jobId, Job storage job, uint256 freelancerPercent) private {
        // Only the part not yet advanced to the freelancer is still held by the contract.
        uint256 pool = job.amount - job.advancePaid;
        // Divide first to avoid overflowing when computing the percentage.
        uint256 freelancerAmount = (pool / 100) * freelancerPercent + (pool % 100) * freelancerPercent / 100;
        uint256 clientAmount = pool - freelancerAmount;
        job.status = JobStatus.Completed;
        emit JobCompleted(jobId, freelancerAmount, clientAmount);
        if (freelancerAmount > 0) _credit(job.freelancer, freelancerAmount);
        if (clientAmount > 0) _credit(job.client, clientAmount);
    }

    function _credit(address recipient, uint256 amount) private {
        balances[recipient] += amount;
    }
}
