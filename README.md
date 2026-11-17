# Freelance Escrow DApp

A client-side Sepolia demo for funding freelance work with ETH held in a Solidity contract. The contract stores jobs on-chain; proofs are references such as a GitHub commit URL, SHA, or IPFS CID, not uploaded files.

**Features:** escrow deposits, an optional 50% advance approved by the client, proof submission, up to two revision requests per job, mutual cancellation, deadline/review timeouts, arbitration with an automatic 50/50 fallback, pull-payment withdrawals, a "My jobs" workspace with role/status filters, and a profile page with transaction history, and a **VI / EN language switch** on every page.

## Requirements

- A browser with MetaMask or another EIP-1193 wallet and an internet connection (the UI loads Tailwind CSS and Ethers.js from CDNs).
- Sepolia selected in the wallet and test ETH for deposits and gas. Use separate client and freelancer accounts; the account deploying the contract is the arbiter.
- [Remix IDE](https://remix.ethereum.org/) to compile and deploy.

## Compile and deploy with Remix

1. Open Remix and create `FreelanceEscrow.sol` under `contracts`. Copy in the contents of this project's `contracts/FreelanceEscrow.sol`.
2. Open **Solidity Compiler**, choose a compiler compatible with `^0.8.20`, and compile the file.
3. In **Deploy & Run Transactions**, choose **Injected Provider - MetaMask**, connect the intended arbiter account, and make sure the wallet is on **Sepolia**. Select `FreelanceEscrow` and deploy. Confirm the transaction and copy the deployed contract address.
4. Keep the deployer/arbiter account available for resolving disputes. The arbiter cannot be changed after deployment.

## Run the frontend

From the project root, run:

```sh
python -m http.server 8000 --directory frontend
```

Open `http://localhost:8000` in the wallet-enabled browser. Alternatively, serve `frontend/` with VS Code Live Server. Connect the wallet, approve a switch to Sepolia if prompted, paste the deployed contract address, and select **Save address**. The address is cached in the browser's local storage; use the same address for every participant. Transactions and errors appear in the activity log.

## Three-step demo

1. **Client deposits:** Connect the client account. Enter the freelancer's address, a title, a duration in whole days, and an amount of Sepolia ETH. Select **Create & deposit** and confirm. The job appears in **My jobs**.
2. **Optional advance and submission:** Freelancer selects **Request 50% advance**. Client opens the job and selects **Approve 50% advance** or **Reject advance**. Only approval credits the freelancer, who then uses **Withdraw**. The freelancer may submit proof before the deadline with or without an advance.
3. **Client releases:** Switch back to the client, open the job, and select **Approve & pay**. The job becomes Completed and the **remaining amount** (the full deposit if no advance was taken) is **credited to the freelancer's escrow balance**. The freelancer then presses **Withdraw** (on the main page or the profile page) to move it to their wallet.

## My jobs

The main page lists every job where the connected wallet is the client or the freelancer (read from the contract's `getUserJobs` index), with role and status filters. Amber badges flag what needs your attention: *Review work*, *Submit work*, *Revision needed*, *Cancel request*, and, for the arbiter, *Resolve*. The arbiter also sees every disputed job under **Arbiter queue**. You can still look up any job by ID.

## Client-approved 50% advance

1. Freelancer calls `requestAdvance(jobId)`. No ETH is credited or transferred.
2. Only that job's client can call `approveAdvance(jobId)` or `rejectAdvance(jobId)`.
3. Approval credits half the deposit (rounded down) to the freelancer's `balances`; `withdraw()` transfers it to their wallet. Approval is final even before withdrawal.

- `startJob` has been removed. There is no direct advance withdrawal path.
- Only one approved advance per job. Rejected requests can be submitted again.
- Request and approval require an open job, no previous submission, no pending cancellation, and a deadline that has not passed. The deposit must be at least 2 wei.
- Silence never approves an advance and does not extend the deadline. Submission without an advance remains allowed and pays the full amount at settlement.
- Submission, a cancellation request, a dispute, or cancellation clears the pending advance request. Withdrawing a cancellation request does not restore it.
- Every later refund or dispute split applies only to the unadvanced balance. Once approved, the advance cannot be clawed back by cancellation or arbitration.
- `advanceRequested(jobId)` exposes pending state. Events: `AdvanceRequested`, `AdvanceApproved`, `AdvanceRejected`, `AdvanceRequestCleared`. `JobStarted` remains as a history-compatible event emitted on approval (not request).

## Revisions

After the freelancer submits, the client may **send the work back** with a note (up to 500 bytes), at most **2 times** per job and only while the 3-day review period is running. The job returns to `Created`, and the deadline becomes at least 3 days from the request (a later existing deadline is kept). The freelancer resubmits; the client can then approve, request another revision (if any are left), or dispute. If the freelancer never resubmits, the client can use **Cancel & refund** after the new deadline.

## Mutual cancellation

While a job is `Created` (nothing submitted), either party can **Request mutual cancel**. The other party sees *Cancel request* and can **Accept**, which cancels the job and credits the client with the part of the deposit not yet advanced. The requester can withdraw the request. A request is voided automatically if work is submitted or a dispute is raised.

## Timeouts and disputes

- If no work is submitted by the deadline, the client can use **Cancel & refund** after the deadline.
- After submission, the freelancer can use **Claim payout** more than three days after submission if the job remains Submitted. The client may still approve during that period.
- Either party can raise a dispute while a job is Created or Submitted. The deployer (arbiter) can inspect the disputed job and enter the freelancer's percentage from 0 to 100. The remainder goes to the client, including any rounding remainder. Resolution is terminal and uses the existing `Completed` status; the `JobCompleted` event records both amounts.
- **Arbiter timeout:** if a dispute is still undecided more than **7 days** after it was raised, either party can use **Force 50/50 split**. Each side is credited half (an odd wei goes to the client), so funds can never be locked by an absent arbiter. Until someone triggers it, the arbiter can still decide normally.
- Deadlines use block timestamps and strict `>` checks for timeout actions. A new block may be needed before an action becomes available; the display refreshes periodically against the latest block. Any party may dispute until a competing settlement transaction is confirmed.

## Language switch (VI / EN)

Every page has a **VI | EN** button in the header. It switches all text, placeholders, tooltips, job statuses, action buttons, hints, log messages and contract error messages without reloading, and remembers the choice in `localStorage` (`escrowLang`). The first visit follows the browser language (Vietnamese browsers get Vietnamese, everything else English).

All translations live in one file, `frontend/i18n.js`, as `key: [English, Tiếng Việt]` pairs. To add a string: add a pair there, then use `data-i18n="key"` (or `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-aria`) in the HTML or `t('key', {vars})` in JavaScript.

## Pull payments (withdrawals)

Settlements never send ETH directly. Approvals, timeouts, refunds, cancellations and dispute splits **credit `balances[address]`**, and each recipient calls `withdraw()` to collect everything owed to them across all jobs. The balance is zeroed before the transfer (checks-effects-interactions). Consequences: a recipient that rejects ETH can only block *their own* withdrawal and can never prevent the other party from being paid, and no settlement can be blocked by a failing transfer.

The contract is an educational demo and has not been independently audited. Proof links are user-supplied; verify them before opening.

## Upgrading from the previous version

The contract ABI changed (new `Job` fields such as `advancePaid`, new functions such as `requestAdvance` and `approveAdvance`, new events), so **deploy the new `contracts/FreelanceEscrow.sol` and save its address** in the frontend. The frontend refuses older deployments with a clear message. Existing jobs on an old deployment are not migrated.
