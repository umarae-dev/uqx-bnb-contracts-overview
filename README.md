# UQX BNB Contracts

> **Production-safe UQX token, vesting and presale contracts for BNB Smart Chain.**

This repository is the public on-chain reference for UQX, the self-custody Web3 wallet and token-utility layer of the Zynost ecosystem. It contains production-safe Solidity source, tests, deployment utilities and recorded BNB Smart Chain deployment evidence.

The repository documents **deployed contract behavior**. It does not redefine historical ABI/source identifiers merely to match newer product terminology.

## Current product context

UQX is currently positioned as a **self-custody Web3 wallet**. The native Android wallet creates a standard EVM wallet on-device and can inspect supported UQX/presale state on BNB Smart Chain.

Older product iterations used mining/reward terminology. The deployed vesting contract still contains the historical enum value `AllocationType.Mining` and corresponding constant names. Those names are retained because they are part of the published/deployed contract source and test surface. They should be read as **legacy allocation identifiers**, not as a statement that the current UQX product is a mining application.

## Included source

### Contracts

- [`contracts/UqxToken.sol`](contracts/UqxToken.sol) — fixed-supply 1,000,000,000 UQX ERC-20/BEP-20 implementation;
- [`contracts/UqxVesting.sol`](contracts/UqxVesting.sol) — Merkle-proof distribution/vesting contract with separate historical allocation accounting and one-time root publication;
- [`contracts/UqxPresale.sol`](contracts/UqxPresale.sol) — capped stablecoin presale with buyer accounting and vesting;
- [`contracts/Imports.sol`](contracts/Imports.sol) — Hardhat import shim for OpenZeppelin TimelockController and local test artifacts.

### Tests

- [`test/uqx/UqxToken.test.js`](test/uqx/UqxToken.test.js)
- [`test/uqx/UqxVesting.test.js`](test/uqx/UqxVesting.test.js)
- [`test/uqx/UqxPresale.test.js`](test/uqx/UqxPresale.test.js)
- [`test/uqx/UqxVestingTimelock.test.js`](test/uqx/UqxVestingTimelock.test.js)
- [`test/uqx/merkleHelper.js`](test/uqx/merkleHelper.js)

### Utilities

- [`scripts/uqx/deploy.js`](scripts/uqx/deploy.js) — token + vesting + timelock deployment flow;
- [`scripts/uqx/deployPresale.js`](scripts/uqx/deployPresale.js) — presale deployment/allowlist/timelock handoff;
- [`scripts/uqx/merkle.js`](scripts/uqx/merkle.js) — Merkle leaf/tree implementation;
- [`scripts/uqx/checkTx.js`](scripts/uqx/checkTx.js) — transaction receipt inspection;
- [`scripts/uqx/checkToken.js`](scripts/uqx/checkToken.js) — token metadata/balance inspection;
- [`scripts/check-public-repo.js`](scripts/check-public-repo.js) — public-source credential/sensitive-file guard.

No private key or production credential belongs in these files. Deployment scripts read sensitive values from environment variables.

## Quick start

Requirements: Node.js 20+ and npm.

```bash
git clone https://github.com/umarae-dev/uqx-bnb-contracts-overview.git
cd uqx-bnb-contracts-overview
npm install
npm run check:public
npm run compile
npm test
```

Local compile/tests require no production credential.

## Contract architecture

```text
                         UqxToken
                    fixed 1B UQX supply
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
         UqxVesting                 UqxPresale
   historical distribution        buyer accounting
      + vesting ledger            + presale vesting
              │                         │
              └────────────┬────────────┘
                           ▼
                 TimelockController
                           │
                           ▼
                    Safe multisig
```

The token itself has no owner, mint, token-level pause or blacklist function. Custom distribution contracts carry narrowly scoped administrative/emergency functions and are intended to sit behind delayed multisig/timelock governance.

## Historical allocation identifier

`UqxVesting.sol` currently declares:

```solidity
enum AllocationType { Mining, Presale }
```

`Mining` is retained exactly because changing a deployed/public source identifier would create an inaccurate representation of the contract history and could break tooling/tests that depend on the existing ABI/source semantics.

For current product documentation:

- treat `AllocationType.Mining` as the **legacy community/distribution allocation type**;
- do not market UQX as a mining or reward-session product;
- do not rewrite the deployed Solidity source merely for branding;
- if a future distribution contract is deployed, new terminology can be designed in that new contract version without falsifying the existing deployment.

## Security invariants covered by tests

### UqxToken

- full 1B supply minted once to treasury;
- zero treasury rejected;
- correct name/symbol/decimals;
- no `mint`, token-level `pause`, blacklist or owner privilege;
- standard ERC-20 transfer behavior.

### UqxVesting

- root can be set only by owner and only once;
- zero root and past launch timestamps rejected;
- nothing claimable before launch;
- immediate-unlock and time-based vesting arithmetic enforced by contract logic;
- historical allocation types remain separately accounted;
- invalid proofs and tampered allocations rejected;
- many-entry Merkle trees supported;
- pause blocks claims without rewriting elapsed vesting time.

### Timelock governance

- vesting ownership can sit behind OpenZeppelin `TimelockController`;
- deployer loses direct owner access after handoff;
- privileged actions follow the configured proposer/executor path;
- scheduled actions cannot execute before the configured delay.

### UqxPresale

- only allowlisted payment tokens accepted;
- payment forwarding uses the configured recipient;
- purchased allocation is recorded on-chain;
- the configured hard cap is enforced;
- pause blocks buy/claim paths;
- unsold withdrawal remains owner-gated and must preserve sold-allocation backing.

## BNB Smart Chain deployment evidence

Public deployment documentation records the BSC mainnet deployment dated **18 August 2026**:

| Component | Address |
|---|---|
| UQX Token | `0x68B1Eb4b344cc86750bd9Ac9e3f4F53B3aF48A28` |
| UQX Vesting | `0xB3d0CD3c7a73F20689223AdF6223F53A8C245326` |
| TimelockController | `0x9dE032505A10F8A9d4D9445A0cEa9bF49320F569` |
| UQX Presale | `0xe2f3931Be4A5e1f7C8266C3312C015E426f625dD` |
| Safe multisig | `0x7E7bAf58129dc3e1992ef2cAfbD981391D522C97` |

See [`DEPLOYMENTS.md`](DEPLOYMENTS.md) and [`ONCHAIN_EVIDENCE.md`](ONCHAIN_EVIDENCE.md) for the recorded state and verification boundaries.

The documented funding state may use historical distribution terminology because that is how the deployed contract/accounting path was originally defined. That terminology is not current UQX app branding.

## UQX wallet relationship

The native UQX application is a separate trust boundary from these contracts:

```text
Android device
   │
   ├── BIP39 recovery phrase + EVM keypair (device-owned)
   │
   └── public wallet address
             │
             ▼
      BNB Smart Chain
             │
             ├── UQX token balance
             └── supported presale / vesting state
```

The current reviewed native BNB client is read-only. This contract repository therefore does not imply that the Android application currently signs or broadcasts arbitrary transactions.

## Public / private boundary

Public here:

- production-safe UQX contract source;
- UQX tests/helpers;
- deployment utilities without secret values;
- public deployment addresses/state;
- Hardhat packaging, CI and security guard.

Never published here:

- `.env` files containing live credentials;
- deployer/Safe private keys or recovery phrases;
- private RPC credentials;
- treasury operational credentials;
- backend/database/user credentials;
- private allocation datasets;
- operational incident runbooks.

See [`PUBLIC_PRIVATE_BOUNDARY.md`](PUBLIC_PRIVATE_BOUNDARY.md), [`PROVENANCE.md`](PROVENANCE.md) and [`SECURITY.md`](SECURITY.md).

## CI

GitHub Actions runs the public-source guard, dependency installation/audit, compile and test workflow. It contains no deployment credential and does not deploy to BNB Smart Chain.

## Disclaimer

This repository is software and technical documentation, not financial advice. Contract state, token balances and deployment configuration should be independently verified before interacting with deployed contracts.
