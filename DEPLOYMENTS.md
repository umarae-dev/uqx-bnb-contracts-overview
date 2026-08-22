# UQX BNB Smart Chain Deployments

## BSC mainnet

Deployment date: **18 August 2026**

| Component | Address | Status |
|---|---|---|
| UQX Token | `0x68B1Eb4b344cc86750bd9Ac9e3f4F53B3aF48A28` | Deployed |
| UQX Vesting | `0xB3d0CD3c7a73F20689223AdF6223F53A8C245326` | Deployed + mining pool funded |
| TimelockController | `0x9dE032505A10F8A9d4D9445A0cEa9bF49320F569` | Deployed |
| UQX Presale | `0xe2f3931Be4A5e1f7C8266C3312C015E426f625dD` | Deployed + presale pool funded |
| Safe multisig | `0x7E7bAf58129dc3e1992ef2cAfbD981391D522C97` | Governance proposer |

## Supply

Total supply:

**1,000,000,000 UQX**

The token contract has no post-deployment mint function.

## Funded pools

### Mining / reward vesting

**250,000,000 UQX**

Funded into the UQX Vesting contract.

The mining Merkle root is **not yet set**. No public documentation should imply that reward-account balances have already been finalized into the irreversible on-chain snapshot.

### Presale

**150,000,000 UQX**

Funded into the UQX Presale contract.

The presale contract has its own per-buyer on-chain allocation and vesting accounting.

## Remaining treasury-held supply

After the two funded pools, **600,000,000 UQX** remains associated with the other ecosystem/tokenomics buckets.

Current planning identifies these broad buckets as:

- Ecosystem & Treasury: 200M;
- Team: 150M;
- DEX Liquidity: 150M;
- Advisors: 50M;
- Community: 50M.

This overview does **not** claim that every remaining bucket already has a dedicated on-chain distribution contract.

## Governance state

The production deployment documentation records that `UqxVesting.owner()` and `UqxPresale.owner()` are controlled by the deployed timelock architecture.

The timelock is configured with an approximately **48-hour delay** and uses the Safe multisig as proposer authority.

## Public verification

These addresses are public BNB Smart Chain data and can be inspected through a BSC block explorer.

Before relying on any address for payment, purchase or token interaction, independently verify it against the project's current official channels and explorer state.

## Deployment-key privacy

The deployer address is public blockchain metadata. The corresponding private key is not public and must never be committed to this repository.

This repository intentionally does not copy deployment scripts or environment configuration from the private production contracts repository.
