# UQX — BNB Smart Chain Contract Architecture

> **A fixed-supply BNB-native token stack with separated token, presale, vesting and governance trust boundaries.**

UQX is the BNB Smart Chain token layer of the broader Zynost ecosystem. The production contracts separate the base token from higher-risk distribution logic so the token itself stays intentionally minimal while presale, vesting and emergency controls live in dedicated contracts.

**Network:** BNB Smart Chain mainnet  
**Token:** Zynost UQX (`UQX`)  
**Standard:** ERC-20 / BEP-20 compatible  
**Solidity:** 0.8.23  
**Deployment date:** 18 August 2026

---

## Mainnet contracts

| Component | BSC mainnet address | Role |
|---|---|---|
| **UQX Token** | `0x68B1Eb4b344cc86750bd9Ac9e3f4F53B3aF48A28` | Fixed-supply UQX asset |
| **UQX Vesting** | `0xB3d0CD3c7a73F20689223AdF6223F53A8C245326` | Merkle-based mining / snapshot distribution |
| **TimelockController** | `0x9dE032505A10F8A9d4D9445A0cEa9bF49320F569` | Delayed governance for privileged distribution actions |
| **UQX Presale** | `0xe2f3931Be4A5e1f7C8266C3312C015E426f625dD` | On-chain stablecoin purchase + vesting |

See [`DEPLOYMENTS.md`](DEPLOYMENTS.md) for current deployment/funding status.

---

## Contract system

```text
                    UQX Token
                  fixed 1B supply
                       │
           ┌───────────┴───────────┐
           │                       │
           ▼                       ▼
     UQX Vesting              UQX Presale
   mining/snapshot pool       stablecoin buyers
           │                       │
           └───────────┬───────────┘
                       │ owner controls
                       ▼
               TimelockController
                       │
                       ▼
                 Safe multisig
```

The key architectural idea is **separation of privilege**:

- the token contract has no owner-controlled minting or blacklist logic;
- distribution contracts contain the custom logic that may need emergency controls;
- those owner actions are routed through delayed governance instead of a direct single-key owner.

---

## UQX Token

The production token contract is intentionally small.

### Fixed supply

The full supply is minted exactly once in the constructor:

**1,000,000,000 UQX**

There is no public or owner-only mint function after deployment.

### No token-level privileged controls

The token contract intentionally does **not** implement:

- additional minting;
- owner-controlled transfer restrictions;
- blacklist functions;
- token-level pause/freeze;
- arbitrary balance modification.

This means distribution/security controls can be upgraded operationally at the surrounding-contract layer without giving an administrator a generic ability to freeze or rewrite balances in the base asset.

---

## Token allocation state

The initial supply is minted to treasury and then allocated into purpose-specific pools.

Current on-chain funding state:

| Pool | Allocation | Status |
|---|---:|---|
| Mining / reward vesting | **250,000,000 UQX (25%)** | Funded into UQX Vesting |
| Presale | **150,000,000 UQX (15%)** | Funded into UQX Presale |
| Remaining ecosystem allocations | **600,000,000 UQX (60%)** | Treasury-held pending dedicated distribution mechanisms |

The remaining allocation includes ecosystem/treasury, team, liquidity, advisors and community buckets. Dedicated on-chain distribution contracts for all of those remaining buckets are **not being claimed as complete yet**.

That distinction is deliberate: this repository documents what is actually deployed, not what is only planned in tokenomics.

---

## UQX Presale

The presale contract records each purchase directly on BNB Smart Chain rather than representing a purchase only in an off-chain database.

Current contract parameters include:

- fixed price: **$0.005 per UQX**;
- maximum presale allocation: **150,000,000 UQX**;
- accepted stablecoin allowlist managed by delayed governance;
- USDT / USDC payment flow on BNB Smart Chain;
- buyer allocation stored on-chain;
- payment forwarded directly to the configured funds recipient;
- presale contract does not intentionally accumulate stablecoin custody;
- hard on-chain cap prevents allocations beyond the presale pool.

### Presale vesting

Each buyer's vesting clock begins from their first purchase.

Current schedule:

- **20% immediately vested**;
- remaining **80% linearly vested over 180 days**.

The buyer claims only the newly vested delta. Previously claimed amounts are tracked on-chain.

---

## Mining / snapshot vesting

The separate UQX Vesting contract is designed to bridge off-chain UQX reward balances into an on-chain claim system at launch/snapshot time.

Rather than storing every reward-account row on-chain during the engagement phase, the final allocation dataset can be committed as a **Merkle root**.

```text
UQX reward ledger
       │
       ▼
deterministic snapshot
       │
       ▼
Merkle tree
       │
       ▼
root committed on-chain once
       │
       ▼
user submits proof for own allocation
       │
       ▼
vesting math determines claimable UQX
```

### Mining allocation schedule

For snapshot-based mining allocations:

- **20% immediately vested** at launch;
- remaining **80% linearly vested over 240 days**.

The vesting contract tracks claimed amounts independently for mining and presale allocation types so one allocation cannot consume the claim history of another.

### Root immutability

The Merkle root can be set only once.

Once set, the owner cannot replace it with a different snapshot through the normal contract interface.

The start timestamp also cannot be set in the past, preventing an accidental configuration that would immediately defeat the intended vesting schedule.

---

## Current mining-vesting status

The **250M UQX mining pool is funded**, but the final mining Merkle root has **not yet been committed**.

That means:

- the contract is funded and ready;
- the application reward ledger is still the source for the pre-snapshot reward state;
- the real snapshot must be generated and independently checked before governance schedules `setRoot()`;
- once executed, the root is intentionally irreversible.

This is an important operational milestone, not something this overview hides behind a generic "live" label.

---

## Delayed governance

Custom distribution contracts contain emergency/administrative functions, but their ownership is not intended to sit directly on a normal deployer wallet.

The deployed architecture routes owner authority through an OpenZeppelin **TimelockController**.

Current governance model:

```text
Safe multisig
    │
    │ proposes owner action
    ▼
TimelockController
    │
    │ mandatory ~48h delay
    ▼
Publicly executable queued action
    │
    ▼
Vesting / Presale contract
```

The delay gives observers time to inspect a queued privileged action before it becomes executable.

Once the delay has passed, execution does not need to depend on one particular signer remaining online.

---

## Emergency controls — where they exist and where they do not

### Base token

**No admin pause.**

A compromised distribution administrator cannot use the UQX token contract itself to globally freeze holders.

### Vesting / presale

These custom contracts do have pause/unpause capability for emergency containment.

That control affects new claim/purchase operations in the corresponding distribution contract — it does not rewrite the UQX token's base balances.

Privileged actions are governed through the timelock architecture.

---

## Trust boundaries

| Component | Can do | Cannot do |
|---|---|---|
| UQX Token | Standard token transfers | Mint new supply after deployment, blacklist holders, freeze token globally |
| UQX Vesting | Verify Merkle proofs, calculate vesting, transfer valid claims | Replace root after it is set, redirect a user's valid allocation through a normal admin claim function |
| UQX Presale | Record purchases, enforce cap, release vested purchases | Sell beyond hard cap |
| Timelock | Execute delayed privileged actions | Bypass its configured delay through the normal governance path |
| Safe multisig | Propose governed actions | Directly rewrite token balances |

---

## Testing

The private production repository contains dedicated test suites for:

- UQX Token;
- UQX Presale;
- UQX Vesting;
- vesting + timelock integration;
- Merkle proof generation/verification helpers.

Tests are used to cover fixed supply, vesting progression, claim accounting, invalid proofs, owner restrictions, emergency pause behavior, presale caps and governance-delay behavior.

A test suite reduces risk but is not a substitute for an independent smart-contract audit.

---

## Relationship to the UQX application

The native Android application intentionally has two distinct layers:

```text
UQX app reward account
        │
        │ future/snapshot bridge
        ▼
UQX Vesting contract
        │
        ▼
On-chain UQX
        │
        ▼
Self-custody BNB wallet
```

Presale positions are already read directly from BNB Smart Chain by the native wallet.

See:

- [UQX Android App Overview](https://github.com/umarae-dev/uqx-app-overview)
- [UQX Backend Overview](https://github.com/umarae-dev/uqx-backend-overview)

---

## Relationship to Zynost

UQX is the BNB-native community/token layer of a wider ecosystem:

```text
Zynost Intelligence
        │
        ├── Zynost Client
        ├── Zynost Pay
        ├── Zynost Paymaster
        │
        └── UQX
             ├── native Android community app
             ├── fixed-supply BNB token
             ├── self-custody wallet
             ├── vesting / rewards bridge
             └── presale infrastructure
```

---

## Technology

Solidity 0.8.23 · OpenZeppelin ERC20 · Ownable · Pausable · SafeERC20 · MerkleProof · TimelockController · Hardhat · ethers.js · BNB Smart Chain

---

## Public vs. private source boundary

This repository is a **public architecture/deployment overview**, not a source-code mirror of the live production contracts repository.

### Public here

- deployed public contract addresses;
- fixed-supply model;
- high-level contract architecture;
- token allocation/funding state;
- vesting rules;
- governance model;
- public security assumptions;
- deployment status.

### Kept private for now

- production deployment scripts;
- deployer/signing credentials;
- operational runbooks;
- private environment configuration;
- production automation;
- unaudited implementation source not yet selected for public release.

**No private key, seed phrase, Safe signer secret, API credential or infrastructure secret belongs in this repository.**

---

## Open-source / BNB hackathon boundary

This overview repository is **not** being presented as the final open-source hackathon submission by itself.

For a BNB hackathon/open-source submission, Zynost should publish a separately scoped, runnable and reproducible component whose source can safely remain public. The commercial production contract repository does not need to be dumped wholesale simply to make this overview look more complete.

---

## Security status

The contracts have internal test coverage and deliberate privilege separation, but this repository does **not** claim an independent external audit unless and until one has actually been completed and published.

See [`SECURITY.md`](SECURITY.md).

---

## Status

**Deployed on BNB Smart Chain mainnet.**

- UQX Token: deployed;
- UQX Vesting: deployed and funded for mining allocation;
- Timelock governance: deployed and controlling privileged distribution actions;
- UQX Presale: deployed and funded;
- mining Merkle root: **not yet set**;
- all remaining tokenomics buckets: **not yet represented by dedicated distribution contracts**.
