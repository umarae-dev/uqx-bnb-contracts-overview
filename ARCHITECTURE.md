# UQX Contract Architecture

## System map

```text
Treasury
  │
  ├── 250M UQX ──> UQX Vesting
  │                    │
  │                    ├── Merkle proof verification
  │                    ├── mining/presale snapshot allocations
  │                    └── time-based claims
  │
  ├── 150M UQX ──> UQX Presale
  │                    │
  │                    ├── accepted stablecoin payment
  │                    ├── hard allocation cap
  │                    └── buyer-specific linear vesting
  │
  └── 600M UQX ──> treasury-held remaining allocations

Safe multisig
   │ proposer
   ▼
TimelockController (~48h)
   │ owner authority
   ├──> UQX Vesting
   └──> UQX Presale

UQX Token itself has no owner/admin interface.
```

## Base token trust model

`UqxToken` is deliberately minimal:

- supply is created once in the constructor;
- total supply is fixed at 1,000,000,000 UQX;
- no post-deploy mint function;
- no blacklist;
- no transfer freeze;
- no token-level pause;
- no owner role.

This reduces the authority attached to any operational governance key after deployment.

## Distribution contracts

### UQX Vesting

The vesting contract is intended for claimable allocations proven by Merkle proof.

The leaf commits to:

- claimant address;
- total allocation;
- allocation type.

Mining and presale allocation types maintain separate cumulative claimed state.

The root is one-time-set and the vesting start cannot be configured in the past.

### UQX Presale

The presale stores buyer state directly on-chain:

```text
Buyer
  ├── totalPurchased
  ├── claimed
  └── firstPurchaseAt
```

A user's first purchase starts their vesting clock. Later purchases increase the same cumulative allocation.

The contract forwards accepted payment assets to the configured funds recipient during purchase rather than intentionally accumulating stablecoin balances inside the sale contract.

## Vesting math

Both current distribution mechanisms use an immediate + linear schedule.

### Mining snapshot allocation

- immediate: 20%
- remaining linear: 80%
- duration: 240 days

### Presale allocation

- immediate: 20%
- remaining linear: 80%
- duration: 180 days

The claim function transfers only:

```text
vested amount - already claimed amount
```

## Governance path

The intended privileged-action path is:

```text
Safe multisig
     │
     │ schedule proposal
     ▼
TimelockController
     │
     │ mandatory delay
     ▼
Execute queued action
     │
     ▼
Distribution contract
```

The timelock controls vesting and presale owner functions. This makes actions such as root-setting, pause/unpause and accepted-payment-token configuration observable before execution rather than instant single-key actions.

## Mainnet state

Current production deployment:

- token deployed;
- vesting deployed;
- timelock deployed;
- presale deployed;
- vesting ownership routed through timelock;
- presale ownership routed through timelock;
- mining pool funded;
- presale pool funded;
- mining Merkle root not yet committed.

## Application integration

The native UQX Android wallet reads contract state directly from BNB Smart Chain for the user's self-custody address.

This includes token balance and presale position information. Reward-account balances remain a distinct server-side accounting surface until a defined on-chain distribution/snapshot transition.

## Security design principle

The architecture favors **limited authority over sophisticated administrator powers**:

- keep the base token simple;
- isolate custom distribution logic;
- put emergency controls where custom logic lives;
- put privileged distribution operations behind delayed governance;
- keep self-custody user keys outside the backend.
