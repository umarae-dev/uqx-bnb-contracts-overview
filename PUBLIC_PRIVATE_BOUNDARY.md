# Public / Private Boundary

This repository is a deliberately scoped open-source reference for UQX contracts on BNB Smart Chain.

## Public

- fixed-supply UQX token source;
- independently runnable public reference implementations of vesting and presale mechanics;
- local Hardhat configuration;
- adversarial tests;
- deployment/address documentation already intended for public verification;
- architecture and security documentation.

## Private / not copied from production

- production deployer keys;
- multisig signer identities or private signing material;
- RPC credentials;
- production treasury operational credentials;
- private governance runbooks;
- internal release procedures;
- snapshot-generation infrastructure and unpublished allocation data;
- any production environment file;
- any operational secret not required to compile or test this public reference.

The public vesting and presale contracts are reference editions derived from the production architecture. They are intentionally distinguishable from live production deployment source/configuration so reviewers can evaluate the mechanism without receiving operational secrets or assuming byte-for-byte identity with deployed contracts.

No secret is required to run the public test suite.
