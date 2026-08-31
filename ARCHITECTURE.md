# UQX Contract Architecture

## System map

```text
Treasury
  │
  ├── 250M UQX ──> UQX Vesting
  │                    │
  │                    ├── Merkle proof verification
  │                    ├── historical allocation-type accounting
  │                    └── time-based claims
  │
  ├── 150M UQX ──> UQX Presale
  │                    │
  │                    ├── accepted stablecoin payment
  │                    ├── hard allocation cap
  │                    └── buyer-specific vesting
  │
  └── 600M UQX ──> treasury-held remaining allocations

Safe multisig
   │ proposer
   ▼
TimelockController
   │ owner authority
   ├──> UQX Vesting
   └──> UQX Presale

UQX Token itself has no owner/admin interface.
```

## Current product relationship

The current UQX application is positioned as a **self-custody Web3 wallet**. Contract distribution identifiers describe the deployed token/distribution architecture; they do not define the present app category.

The deployed/public `UqxVesting` source retains `AllocationType.Mining`. That value is a historical compatibility identifier. Renaming it in the published source would misrepresent the deployment and can break ABI/source-dependent tooling, so the contract name remains unchanged while current product documentation no longer markets UQX as a mining application.

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

The vesting contract handles claimable allocations proven by Merkle proof. Each leaf commits to:

- claimant address;
- total allocation;
- allocation type.

Historical allocation types maintain separate cumulative claimed state. The root is one-time-set and the vesting start cannot be configured in the past.

### UQX Presale

The presale stores buyer state directly on-chain:

```text
Buyer
  ├── totalPurchased
  ├── claimed
  └── firstPurchaseAt
```

A buyer's first purchase establishes the applicable vesting clock; later purchases increase the cumulative allocation under the contract's rules. Accepted payment assets are forwarded to the configured recipient rather than intentionally held as the sale contract's operating balance.

## Vesting math

The currently deployed/public source contains two allocation schedules:

### Historical community/distribution allocation

Contract identifier: `AllocationType.Mining`

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

The first schedule's Solidity identifier is retained for compatibility and historical accuracy. Current UQX product branding does not use mining/reward terminology.

## Governance path

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

The timelock controls vesting and presale owner functions so privileged distribution actions follow the configured delayed-governance path rather than an instant single-key path.

## Mainnet state

The recorded production deployment includes the token, vesting contract, timelock and presale contract, with ownership routing documented in `DEPLOYMENTS.md` and chain evidence documented in `ONCHAIN_EVIDENCE.md`.

Where older deployment records use terms such as “mining pool” or “mining Merkle root,” read those as the historical `AllocationType.Mining` distribution bucket. They should not be carried forward as current UQX consumer branding.

## Native wallet integration

The UQX Android wallet has a separate trust boundary from contract governance:

```text
Android device
   │
   ├── BIP39 mnemonic + EVM keypair
   ├── Android Keystore-backed local storage
   └── public wallet address
            │
            ▼
      BNB Smart Chain
            │
            ├── UQX balance
            └── supported presale state
```

The reviewed native BNB client uses read-only chain calls. Wallet credentials remain device-owned and are not required by the application backend for these reads.

## Security design principle

The architecture favors limited authority and explicit trust boundaries:

- keep the base token simple;
- isolate custom distribution logic;
- place emergency controls where custom logic exists;
- route privileged distribution operations through delayed governance;
- keep self-custody wallet credentials outside the backend;
- preserve deployed source/ABI history instead of cosmetically rewriting contract identifiers.
