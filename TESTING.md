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

`npm test` compiles Solidity and runs `test/FreelanceEscrow.test.js`. Hardhat provides fake funded addresses and controllable block timestamps. Every test restores a fresh blockchain snapshot so the order of tests does not affect results.

## Scenarios covered

- Deployment: immutable arbiter and three-day review period.
- Deposit: required fields, positive payment, distinct participants, emitted events, job storage, and isolated funds across jobs.
- Delivery: freelancer-only submission, proof requirements, one submission per job, on-time/deadline/late submissions.
- Approval: client-only payout, exact ETH movement, terminal status, no duplicate payouts.
- Cancellation: only the client, strictly after deadline, only before submission; otherwise revert.
- Freelancer timeout: strictly after the three-day review period, and only for a submitted job.
- Disputes: who can raise/resolve them, allowed states, split percentages of 0%, 25%, 100%, rounding in wei, and terminal behavior.
- Reverting recipients: failed ETH transfer reverts the *whole* settlement without losing escrowed funds.

These are automated EVM behavioral tests, **not** a formal verification or independent security audit. They do not exercise the browser UI or Sepolia infrastructure. The exact deadline semantics follow the contract's strict `>` timeout conditions.
