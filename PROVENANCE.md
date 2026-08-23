# Provenance

The UQX contract system was developed as part of the wider Zynost/UQX production stack before this public-source extraction.

This repository now publishes the production-safe UQX contract subset directly rather than rewritten reference substitutes:

- `contracts/UqxToken.sol` is copied from the production UQX source;
- `contracts/UqxVesting.sol` is copied from the production UQX source;
- `contracts/UqxPresale.sol` is copied from the production UQX source;
- `contracts/Imports.sol` mirrors the production Hardhat import shim used for TimelockController and the local fixed-supply stablecoin test contract;
- `test/uqx/` contains the production UQX contract tests and Merkle helper copied without credentials or user data;
- `scripts/uqx/` contains production UQX deployment/inspection/Merkle utilities that reference environment variables but contain no private-key values;
- `DEPLOYMENTS.md` records public BNB Smart Chain deployment addresses and public state separately from credentials and private operational data.

The public repository history represents the date of public extraction and maintenance. It is not backdated to impersonate the earlier private production-development history.

Production `.env` files, private keys, RPC credentials, unpublished allocation data and operational secrets are not part of this repository.

See `PUBLIC_PRIVATE_BOUNDARY.md` for the disclosure model.
