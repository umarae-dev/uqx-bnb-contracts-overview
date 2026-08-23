# Provenance

The UQX contract system was developed as part of the wider Zynost/UQX production stack before this public-source extraction.

This repository intentionally preserves that distinction:

- `contracts/UqxToken.sol` is a production-safe fixed-supply token implementation suitable for direct public inspection;
- `contracts/UqxVestingReference.sol` and `contracts/UqxPresaleReference.sol` are independently runnable public reference editions derived from the production contract architecture;
- the public Hardhat tests were written to verify the externally important invariants without copying production credentials, governance configuration, snapshot data or operational runbooks;
- `DEPLOYMENTS.md` documents public on-chain addresses and transaction evidence separately from the reference source package.

The public repository history represents the date of public extraction and maintenance. It is not backdated to impersonate the earlier private production-development history.

See `PUBLIC_PRIVATE_BOUNDARY.md` for the disclosure model.
