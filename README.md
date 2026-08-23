# UQX BNB Contracts

> **Open-source production-safe UQX smart contracts, tests and deployment utilities for BNB Smart Chain.**

This repository is a clean public extraction of the UQX smart-contract subsystem from the wider Zynost production stack. The Solidity contracts and UQX test suite are copied from production-safe source; production credentials, private environment files, unpublished allocation data and unrelated backend systems are deliberately excluded.

## Included source

### Contracts

- [`contracts/UqxToken.sol`](contracts/UqxToken.sol) — fixed-supply 1,000,000,000 UQX ERC-20/BEP-20 implementation;
- [`contracts/UqxVesting.sol`](contracts/UqxVesting.sol) — Merkle-proof mining/presale vesting with separate allocation accounting, one-time root and emergency pause;
- [`contracts/UqxPresale.sol`](contracts/UqxPresale.sol) — capped stablecoin presale with direct payment forwarding and buyer vesting;
- [`contracts/Imports.sol`](contracts/Imports.sol) — Hardhat import shim for OpenZeppelin TimelockController and local test token artifacts.

### Production-derived tests

- [`test/uqx/UqxToken.test.js`](test/uqx/UqxToken.test.js)
- [`test/uqx/UqxVesting.test.js`](test/uqx/UqxVesting.test.js)
- [`test/uqx/UqxPresale.test.js`](test/uqx/UqxPresale.test.js)
- [`test/uqx/UqxVestingTimelock.test.js`](test/uqx/UqxVestingTimelock.test.js)
- [`test/uqx/merkleHelper.js`](test/uqx/merkleHelper.js)

### Production UQX utilities

- [`scripts/uqx/deploy.js`](scripts/uqx/deploy.js) — token + vesting + timelock deployment flow;
- [`scripts/uqx/deployPresale.js`](scripts/uqx/deployPresale.js) — presale deployment/allowlist/timelock handoff;
- [`scripts/uqx/merkle.js`](scripts/uqx/merkle.js) — production Merkle leaf/tree implementation;
- [`scripts/uqx/checkTx.js`](scripts/uqx/checkTx.js) — transaction receipt inspection;
- [`scripts/uqx/checkToken.js`](scripts/uqx/checkToken.js) — token metadata/balance inspection;
- [`scripts/check-public-repo.js`](scripts/check-public-repo.js) — public-source guard against obvious credential material and forbidden secret files.

No real private key or production credential is stored in these files. Deployment scripts read sensitive values only from environment variables.

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

Local compile/tests require **no production secret**.

## Architecture

```text
                         UqxToken
                    fixed 1B UQX supply
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
         UqxVesting                 UqxPresale
   mining + presale Merkle       direct buyer accounting
   20% immediate unlock         fixed on-chain price
   240d mining remainder        150M hard cap
   180d presale remainder       180d vesting
              │                         │
              └────────────┬────────────┘
                           ▼
                 TimelockController
                           │
                           ▼
                    Safe multisig
```

The token itself has no owner, mint, pause or blacklist function. Custom distribution contracts carry owner-gated emergency/administrative functions and are intended to sit behind delayed multisig/timelock governance.

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
- 20% immediate unlock;
- mining remainder vests over 240 days;
- presale remainder vests over 180 days;
- invalid proofs and tampered allocations rejected;
- mining/presale claims for the same wallet remain independent;
- many-entry Merkle trees supported;
- pause blocks claims without changing vesting progress.

### Timelock governance

- vesting ownership can sit behind OpenZeppelin `TimelockController`;
- deployer loses direct owner access;
- only proposer/multisig can schedule privileged actions;
- scheduled action cannot execute before delay;
- execution can be permissionless after the configured delay;
- pause follows the same delayed governance path.

### UqxPresale

- only allowlisted payment tokens accepted;
- payment is forwarded directly to the configured recipient;
- purchased UQX allocation is recorded on-chain;
- 20% immediate + 180-day vesting;
- subsequent purchases keep the original vesting clock;
- 150M UQX cap enforced;
- pause blocks buy/claim;
- unsold withdrawal remains owner-gated and preserves sold allocation backing.

## BNB Smart Chain deployment evidence

Public deployment documentation records the following BSC mainnet deployment dated **18 August 2026**:

| Component | Address |
|---|---|
| UQX Token | `0x68B1Eb4b344cc86750bd9Ac9e3f4F53B3aF48A28` |
| UQX Vesting | `0xB3d0CD3c7a73F20689223AdF6223F53A8C245326` |
| TimelockController | `0x9dE032505A10F8A9d4D9445A0cEa9bF49320F569` |
| UQX Presale | `0xe2f3931Be4A5e1f7C8266C3312C015E426f625dD` |
| Safe multisig | `0x7E7bAf58129dc3e1992ef2cAfbD981391D522C97` |

See [`DEPLOYMENTS.md`](DEPLOYMENTS.md) for recorded funding/governance state and caveats.

Documented state includes:

- total supply: 1,000,000,000 UQX;
- mining/reward vesting funded: 250M UQX;
- presale funded: 150M UQX;
- mining Merkle root not yet set at the documented state;
- remaining treasury-held tokenomics buckets are not represented as already having dedicated distribution contracts unless separately documented.

## Environment and deployment

Compilation and local tests do not need `.env`.

For your own deployment/inspection environment:

```bash
cp .env.example .env
```

Fill values locally. **Never commit the resulting `.env`.** The template contains variable names/placeholders only.

Example production-derived commands:

```bash
npx hardhat run scripts/uqx/deploy.js --network bscTestnet
npx hardhat run scripts/uqx/deploy.js --network bsc
npx hardhat run scripts/uqx/deployPresale.js --network bsc
```

These commands can spend real BNB or alter live governance when pointed at mainnet. Review addresses, signer choice, funding and chain before executing them.

## Public / private boundary

Public here:

- production-safe UQX contract source;
- production UQX tests/helpers;
- production UQX scripts without secret values;
- public deployment addresses/state;
- independent Hardhat packaging, CI and security guard.

Never published here:

- real `.env` files;
- deployer/Safe private keys or seed phrases;
- private RPC credentials;
- treasury operational credentials;
- API/backend credentials;
- database/user data;
- unpublished Merkle allocation datasets;
- private operational/incident runbooks;
- unrelated commercial backend infrastructure.

See [`PUBLIC_PRIVATE_BOUNDARY.md`](PUBLIC_PRIVATE_BOUNDARY.md) and [`PROVENANCE.md`](PROVENANCE.md).

## CI

GitHub Actions performs:

```text
node scripts/check-public-repo.js
npm install
npm run compile
npm test
```

The workflow runs on pushes, pull requests and manual dispatch. It intentionally contains no deployment credential and never deploys to a live chain.

## Security

Do not put a real credential in a public issue, commit, pull request, workflow, `.env.example`, test fixture or deployment example. Public contract addresses and transaction hashes are not secrets.

See [`SECURITY.md`](SECURITY.md) for trust assumptions and responsible disclosure guidance.

## Provenance

The wider production system predates this public extraction. Public Git history reflects the extraction/maintenance timeline and is not backdated to imitate private development history.

See [`PROVENANCE.md`](PROVENANCE.md).

## License

MIT. See [`LICENSE`](LICENSE).

Open-source source code does not grant rights to Zynost/UQX trademarks or branding.

## Disclaimer

This repository is software and technical documentation, not financial advice. It does not promise token price appreciation, investment returns or future market performance. Independently verify current chain state before interacting with deployed contracts.
