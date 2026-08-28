# SafeCore V1 — Bounded-Loss Security Kernel

> Status: experimental architecture and prototype. **Not audited. Not production-ready.**

SafeCore V1 is deliberately narrower than a general smart wallet. Its first job is to make one security statement enforceable by contract code rather than by the Android UI:

> Compromise of the operational spending key alone must not permit immediate asset loss above the user's precommitted per-asset risk budget.

## Authorities

### Operational owner
- Can transfer assets only within existing budgets.
- Cannot bypass budgets.
- Can reduce a budget immediately.
- Can request a higher budget, but cannot activate it before the immutable security delay.
- Cannot perform arbitrary `call`/`delegatecall` or token approvals in V1.

### Recovery key
- Cannot spend.
- Can initiate delayed owner recovery.
- Can cancel a pending budget increase.

### Veto key
- Cannot spend.
- Can cancel a pending owner recovery.
- Can cancel a pending budget increase.

No role is intended to be an unrestricted root/admin key.

## Monotonic safety rule

Safety may tighten immediately; safety may weaken only slowly.

Examples:
- 100 UQX/day → 20 UQX/day: immediate.
- 20 UQX/day → 1,000 UQX/day: delayed.
- compromised owner requests 1,000 UQX/day: visible pending action and cancellable before activation.
- recovery rotates owner: delayed and vetoable.

## V1 transfer surface

V1 intentionally supports only:
- native BNB transfer subject to a native-asset budget;
- ERC-20 transfer subject to the token contract's budget.

V1 intentionally does **not** support:
- arbitrary target calls;
- `delegatecall`;
- ERC-20 approvals/allowances;
- Permit / Permit2 signing;
- NFT transfers;
- swaps through arbitrary routers;
- upgradeability;
- admin rescue withdrawals;
- backend-controlled emergency keys.

Those capabilities can create indirect spend paths that make a simple transfer budget meaningless. They require separate capability-specific policy modules and proofs before being admitted into the SafeCore trust boundary.

## Budget semantics

- Budgets are denominated in native token units, not USD.
- A zero limit means spending disabled, never unlimited.
- Each asset tracks spent amount independently.
- V1 resets usage after a one-day epoch.
- A successful transfer consumes budget before the external token/native transfer occurs; transaction reversion rolls state back atomically.

USD-denominated risk budgets require a carefully selected oracle design and are explicitly outside V1.

## Recovery model

Recovery is not an instant master key.

1. Recovery authority requests a new operational owner.
2. Contract starts the immutable minimum security delay.
3. Existing owner or veto authority may cancel during the delay.
4. Only after the delay can the committed owner rotation be finalized.

Future versions should support stronger multi-factor recovery (for example trusted device + recovery card + time delay), but should preserve the rule that no single recovery credential can instantly drain funds.

## Threats V1 directly targets

- leaked operational private key;
- malware that obtains the operational signing credential;
- malicious request to raise spending limits immediately;
- compromised recovery key attempting immediate spend;
- accidental recovery request;
- accidental or malicious security weakening.

## Threats V1 does not solve by itself

- compromise of multiple independent authorities at once;
- malicious/faulty ERC-20 token implementations;
- chain consensus failure;
- censorship;
- UI phishing before funds are moved into SafeCore;
- seed compromise while assets remain in a plain EOA;
- arbitrary dApp execution (not supported in V1);
- bugs in this unaudited prototype.

## Required release gates

SafeCore must not be marketed as active protection until all applicable gates pass:

1. Contract compiles under the pinned repository toolchain.
2. Unit tests cover all authorization and delay boundaries.
3. Property/fuzz tests assert spend never exceeds budget inside an epoch.
4. Static analyzers are clean or findings are explicitly resolved.
5. Independent smart-contract audit completed.
6. Mainnet deployment address publicly verified.
7. Android wallet reads policy state directly from chain.
8. Android UI clearly separates protected SafeCore balance from plain EOA balance.
9. User migration is opt-in and never silently moves funds.
10. Recovery tooling exists independently of Zynost/UQX backend services.

## Current prototype

`contracts/SafeCoreAccountV1.sol`

The prototype is non-upgradeable and intentionally minimal. It is a research/audit target, not a production deployment recommendation.
