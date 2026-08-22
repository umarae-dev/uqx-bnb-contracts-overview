# Security Policy & Trust Boundary

## Scope

This repository documents the public architecture of the UQX BNB Smart Chain contracts. It is not the production source repository and contains no deployment credential or signer secret.

## Security model

### UQX Token

The base token minimizes privileged behavior:

- fixed supply minted once at deployment;
- no post-deployment mint function;
- no blacklist;
- no token-level pause;
- no owner-controlled balance rewrite.

This reduces the consequences of an operational key compromise at the token layer.

### UQX Vesting

The vesting contract introduces custom logic, so it carries stronger controls:

- Merkle-proof validation;
- allocation-type separation;
- cumulative claim accounting;
- one-time Merkle-root configuration;
- launch timestamp guard;
- emergency pause/unpause;
- privileged actions routed through timelock governance.

### UQX Presale

The presale contract enforces:

- accepted-payment-token allowlist;
- hard UQX sale cap;
- direct buyer allocation accounting;
- cumulative claim tracking;
- deterministic time-based vesting;
- emergency pause/unpause;
- delayed owner control through the timelock.

## Governance

Privileged actions on the custom distribution contracts are intended to pass through a Safe multisig-controlled OpenZeppelin TimelockController with an approximately 48-hour configured delay.

This does not make governance risk disappear. It makes privileged actions harder to execute instantly and gives observers time to inspect queued operations.

## Operational risks that remain

Important risks include:

- incorrect Merkle snapshot generation before irreversible root commitment;
- compromised multisig signers;
- unsafe treasury operations;
- dependency vulnerabilities;
- deployment/configuration mistakes;
- undiscovered smart-contract bugs;
- incomplete distribution mechanisms for treasury-held allocations;
- legal/regulatory risk around token sale/distribution.

## Current transparent limitations

- An independent external audit is not claimed here unless a published audit is linked later.
- The mining Merkle root has not yet been committed.
- Remaining treasury tokenomics buckets do not all have dedicated on-chain vesting/distribution contracts yet.
- Internal tests are useful evidence but are not equivalent to third-party audit assurance.

## Secrets

Never commit or disclose:

- deployer private keys;
- Safe signer seed phrases/private keys;
- RPC credentials if private;
- production `.env` contents;
- API credentials;
- operational recovery secrets;
- user wallet seed phrases/private keys.

Public contract addresses and transaction hashes are not secrets.

## Responsible disclosure

If you discover a vulnerability that could affect deployed contracts, treasury assets, claims or user funds, report it privately to the Zynost/UQX team before public disclosure so mitigation can be evaluated.

Do not include private keys, seed phrases or unrelated personal data in a security report.

## Audit position

The project should avoid claims such as "unhackable", "fully audited" or "safer than every competing token" unless independent evidence supports them.

A future public security package should ideally include:

- independent audit report;
- verified source code for contracts intended for public verification;
- reproducible deployment metadata;
- dependency versions;
- threat model;
- test coverage summary;
- bug-bounty / disclosure process.
