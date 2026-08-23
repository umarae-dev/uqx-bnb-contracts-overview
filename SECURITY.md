# Security Policy & Trust Boundary

## Scope

This repository publishes the production-safe UQX BNB Smart Chain contract subsystem, its UQX tests and selected deployment/inspection utilities. It is a clean public extraction, not the private production repository, and it must never contain a real deployment credential, signer secret, user database or unpublished allocation dataset.

## Security model

### UQX Token

The base token minimizes privileged behavior:

- fixed supply minted once at deployment;
- no post-deployment mint function;
- no blacklist;
- no token-level pause;
- no owner-controlled balance rewrite.

### UQX Vesting

The vesting contract includes custom logic and therefore additional controls:

- Merkle-proof validation;
- mining/presale allocation-type separation;
- cumulative claim accounting per allocation type;
- one-time Merkle-root configuration;
- past-launch timestamp rejection;
- emergency pause/unpause;
- privileged actions intended to route through delayed timelock governance.

### UQX Presale

The presale contract enforces:

- accepted-payment-token allowlist;
- hard UQX sale cap;
- direct buyer allocation accounting;
- payment forwarding to the configured recipient;
- cumulative claim tracking;
- deterministic time-based vesting;
- emergency pause/unpause;
- owner control intended to sit behind the existing timelock.

## Governance

The documented deployment routes privileged distribution-contract actions through a Safe multisig-controlled OpenZeppelin `TimelockController` with an approximately 48-hour configured delay. This does not remove governance risk; it prevents immediate unilateral owner actions and provides a public delay before scheduled operations become executable.

## Dependency audit policy

CI runs `npm audit --omit=dev --audit-level=high` as a blocking check for runtime npm dependencies used by the public utilities. The public package intentionally uses a minimal Hardhat 2 development stack because the production-derived test suite is copied without rewriting its CommonJS/Hardhat-2 behavior.

A full `npm audit` can report advisories inherited from the legacy Hardhat-2 compiler/test dependency graph. Those are development-tool advisories, not dependencies embedded in deployed UQX bytecode or the runtime `ethers`/`dotenv` utility dependency set. They are not hidden or represented as zero-risk. Migrating the copied test harness to Hardhat 3 would be a separate tooling migration and would no longer be a byte-for-byte copy of the production test harness.

The public dependency set removes unused toolbox plugins such as coverage, gas reporting, Ignition and TypeChain to reduce unnecessary attack surface while preserving the exact copied UQX tests.

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

## Transparent limitations

- An independent external audit is **not** claimed unless a published audit is linked here later.
- Internal/CI tests are evidence of tested invariants, not a substitute for third-party audit assurance.
- `DEPLOYMENTS.md` is timestamped documentation; current on-chain state should be independently verified before interacting with live contracts.

## Secrets and sensitive data

Never commit or disclose:

- any real `.env` file;
- deployer private keys or seed phrases;
- Safe signer seed phrases/private keys;
- keystore files;
- private RPC/API/database credentials;
- service-account credentials;
- treasury operational recovery secrets;
- database dumps, logs or backups containing private data;
- unpublished Merkle allocation datasets/user balances;
- user wallet seed phrases/private keys.

Public contract addresses and transaction hashes are not secrets.

The repository includes `scripts/check-public-repo.js` and CI checks for obvious credential patterns and forbidden sensitive filenames. These checks reduce accidental disclosure risk but do not replace human review.

## Responsible disclosure

If you discover a vulnerability that could affect deployed contracts, treasury assets, claims or user funds, use a private communication channel with the Zynost/UQX team before public disclosure so mitigation can be evaluated. Do not paste exploit-enabling live-system secrets, private keys, seed phrases or unrelated personal data into a public issue.

## Audit position

Do not describe this project as "unhackable", "fully audited" or guaranteed safe unless independent evidence supports that statement. Verified source, tests, CI and public deployment evidence improve transparency but are not equivalent to a professional external audit.
