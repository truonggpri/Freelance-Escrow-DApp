# Local smart-contract simulation tests

The suite deploys the **real** `FreelanceEscrow.sol` to Hardhat's in-memory EVM. It uses separate simulated wallets for the deployer/arbiter, client, freelancer, and unrelated account. No Sepolia RPC, MetaMask, private keys, or real ETH are needed.

## Requirements

- Node.js **22.13.0+** and npm

## Run

From the repository root:

```bash
npm install
npm test
```

Optional:

```bash
npm run compile
npm run test:coverage
```

`npm test` compiles Solidity and runs the contract and frontend/ABI tests. Hardhat provides fake funded addresses and controllable block timestamps. Every test restores a fresh blockchain snapshot so the order of tests does not affect results.

## Scenarios covered

- Deployment: immutable arbiter and the protocol constants (3-day review, 3-day revision period, 7-day arbiter timeout, 2 revisions).
- Deposit: required fields, positive payment, distinct participants, emitted events, job storage, and isolated funds across jobs.
- Per-user index: `getUserJobs` lists jobs for both the client and the freelancer.
- Delivery: freelancer-only submission, proof requirements, one submission per open job, on-time/deadline/late submissions.
- Approval: client-only payout, exact credit, terminal status, no duplicate payouts.
- Revisions: client-only, note required/length-limited, review-period window, maximum of two, deadline extension (and keeping a later deadline), resubmission, interaction with cancellation and the freelancer's timeout claim.
- Cancellation: only the client, strictly after deadline, only before submission; otherwise revert.
- Mutual cancellation: request / accept / withdraw by the right parties, duplicate and outsider rejection, automatic voiding on submission or dispute, no repeats.
- Freelancer timeout: strictly after the three-day review period, and only for a submitted job.
- Disputes: who can raise/resolve them, allowed states, split percentages of 0%, 25%, 100%, rounding in wei, and terminal behavior.
- Arbiter timeout: strictly after 7 days, parties only, 50/50 split with the odd wei to the client, arbiter can still decide before it is triggered, and it is terminal.
- Advance payment: half credited only on client `approveAdvance` after freelancer `requestAdvance`, optional, rounding, access/state/deadline/once-only rules, blocked after a submission or during a cancel request, and every later payout, refund, arbiter split and timeout split applying only to the remaining half (with a solvency check that credited balances never exceed the contract's ETH).
- Pull payments: credit-then-withdraw accounting, `Withdrawn` event, no double withdrawal, aggregation across jobs, withdrawals isolated per user.
- Reverting recipients: a contract that rejects ETH can only fail its *own* withdrawal; it cannot block the client's refund, an arbiter split, or a timeout split.

These are automated EVM behavioral tests, **not** a formal verification or independent security audit. They do not exercise the browser UI or Sepolia infrastructure. The exact deadline semantics follow the contract's strict `>` timeout conditions.

Frontend advance-action rendering and ABI signatures are covered by `npm test` using a simulated DOM. The full browser UI, including the VI / EN switch, is not covered by this suite.

Advance approval regressions also cover unauthorized approval/rejection, duplicate requests, rejection and re-request, no credit before approval, no automatic approval, stale request clearing, revision rounds, full refunds without approved advances, and repeat approval prevention.

Validation of this update: Solidity 0.8.20 compiled successfully; npm test passed 88 tests (85 contract tests and 3 frontend/ABI checks). Frontend tests use a simulated DOM; no live MetaMask/Sepolia transaction was performed.
