# UQX BNB Contracts — Public Reference

[![CI](https://github.com/umarae-dev/uqx-bnb-contracts-overview/actions/workflows/ci.yml/badge.svg)](https://github.com/umarae-dev/uqx-bnb-contracts-overview/actions/workflows/ci.yml)

> **Runnable Solidity reference for the UQX token, allocation vesting, and presale mechanics on BNB Smart Chain.**

This repository contains real executable Solidity and Hardhat tests. It is intentionally separated from production deployment secrets and governance operations.

## What is public

- `contracts/UqxToken.sol` — fixed-supply 1B UQX token implementation;
- `contracts/UqxVestingReference.sol` — independently runnable Merkle-based vesting reference;
- `contracts/UqxPresaleReference.sol` — independently runnable fixed-price presale/vesting reference;
- adversarial Hardhat tests;
- local-only Hardhat config;
- public BSC deployment documentation;
- architecture, security, provenance, and disclosure-boundary docs.

The vesting and presale contracts are explicitly named **Reference** because they are public reusable editions derived from the production architecture, not a promise of byte-for-byte identity with live deployment source/configuration.

## Quick start

Requirements: Node.js 20+ and npm.

```bash
git clone https://github.com/umarae-dev/uqx-bnb-contracts-overview.git
cd uqx-bnb-contracts-overview
npm install
npm run compile
npm test
```

The default configuration uses the local Hardhat network. No production key, signer, RPC credential, treasury credential, multisig secret, or environment file is required.

## Contract architecture

```text
                         UQX Token
                    fixed 1B supply
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
   Vesting Reference             Presale Reference
   Merkle allocations            direct buyer accounting
   20% immediate                 20% immediate
   linear remainder              linear remainder
   mining: 240 days              180 days
   presale: 180 days             stablecoin allowlist
            │                           │
            └─────────────┬─────────────┘
                          ▼
                   user-controlled wallet
                          │
                          ▼
                  BNB Smart Chain
```

## Security invariants demonstrated publicly

### UQX token

- supply is minted once in the constructor;
- no post-deployment mint function;
- no owner role;
- no token-level pause;
- no blacklist;
- no privileged balance rewrite.

### Vesting reference

- Merkle root can be set once;
- zero root rejected;
- launch timestamp cannot be placed in the past;
- allocation type is part of the leaf and claim accounting;
- mining and presale claims maintain separate cumulative totals;
- 20% immediate unlock, remainder linear;
- invalid proofs rejected;
- pause affects claims, not token transfers.

### Presale reference

- payment token must be explicitly allowlisted;
- presale cap enforced on-chain;
- buyer allocation recorded on-chain;
- payment forwards directly to the configured recipient;
- 20% immediate unlock, remainder linear over 180 days;
- administrative controls remain owner-gated;
- reference configuration contains no production addresses or keys.

## Tests

The public suite covers important invariants including:

- exact fixed supply;
- zero-address constructor protection;
- one-time vesting root;
- 20% launch vesting;
- invalid Merkle proof rejection;
- claim pause behavior;
- payment forwarding;
- buyer allocation accounting;
- payment-token allowlist enforcement;
- owner-only administration.

Run:

```bash
npm test
```

## BSC mainnet evidence

Public deployment documentation records the following BSC mainnet deployment dated **18 August 2026**:

| Component | Address |
|---|---|
| UQX Token | `0x68B1Eb4b344cc86750bd9Ac9e3f4F53B3aF48A28` |
| UQX Vesting | `0xB3d0CD3c7a73F20689223AdF6223F53A8C245326` |
| TimelockController | `0x9dE032505A10F8A9d4D9445A0cEa9bF49320F569` |
| UQX Presale | `0xe2f3931Be4A5e1f7C8266C3312C015E426f625dD` |
| Safe multisig | `0x7E7bAf58129dc3e1992ef2cAfbD981391D522C97` |

See [`DEPLOYMENTS.md`](DEPLOYMENTS.md) for funded-pool status, governance context, and important caveats.

The deployment documentation currently records:

- 1,000,000,000 UQX total supply;
- 250M UQX funded to the mining/reward vesting pool;
- 150M UQX funded to the presale pool;
- mining Merkle root not yet set at the documented state;
- remaining treasury-held allocation buckets are not all claimed to have dedicated distribution contracts.

## Public / private boundary

### Public

- reusable contract mechanics;
- public reference source;
- tests;
- architecture/security docs;
- public chain addresses and transaction evidence intended for verification.

### Not published

- deployer private keys;
- production signer/multisig secrets;
- RPC credentials;
- treasury operational credentials;
- production environment files;
- private governance runbooks;
- internal release procedures;
- snapshot-generation infrastructure;
- unpublished user allocation data.

See [`PUBLIC_PRIVATE_BOUNDARY.md`](PUBLIC_PRIVATE_BOUNDARY.md).

## Production lineage

This repository is a public-source extraction from a wider private production codebase. Public history is not backdated to imitate private development history.

See [`PROVENANCE.md`](PROVENANCE.md).

## CI

GitHub Actions runs:

```text
npm install
npm run compile
npm test
```

on pushes and pull requests. The project is intentionally configured for local deterministic testing rather than embedding production deployment configuration in CI.

## Security

No secret is required to compile or test this repository. `.env`, private-key files, generated artifacts, and local dependency directories are excluded from source control by default.

Do not open a public issue containing production credentials, exploitable live-system secrets, or private user allocation data. See [`SECURITY.md`](SECURITY.md).

## License

MIT. See [`LICENSE`](LICENSE).

Open-source code does not grant rights to Zynost/UQX trademarks or branding.

## Disclaimer

This repository is technical documentation and reference software. It is not financial advice and does not promise token price appreciation, investment return, or future market performance. Independently verify current deployment addresses and contract state before interacting with BNB Smart Chain.
