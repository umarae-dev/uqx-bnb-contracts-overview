# Public / Private Boundary

This repository publishes the production-safe UQX smart-contract subset for BNB Smart Chain while keeping credentials, private operational data and unrelated production systems out of source control.

## Public

- production-safe `UqxToken`, `UqxVesting` and `UqxPresale` Solidity source;
- production UQX Hardhat tests and Merkle helper;
- production UQX Merkle/deployment/inspection scripts that contain environment-variable references but no secret values;
- OpenZeppelin TimelockController integration test and import shim;
- secret-free Hardhat packaging/configuration needed to compile and test independently;
- public deployment/address documentation intended for on-chain verification;
- architecture, provenance and security documentation.

## Private / deliberately excluded

- every real `.env` file;
- deployer private keys or seed phrases;
- Safe/multisig signer private material;
- private RPC credentials;
- treasury operational credentials;
- API keys and unrelated backend/service credentials;
- private governance/incident runbooks;
- internal release procedures that contain operational secrets;
- snapshot-generation infrastructure tied to private databases;
- unpublished Merkle allocation datasets and user data;
- database dumps, logs, backups, service-account files or keystores;
- unrelated production systems not required to compile or evaluate the UQX contracts.

Public contract addresses, token addresses, transaction hashes and intentionally public BNB Chain state are not secrets.

The repository must remain independently compilable and testable without any production credential. `.env.example` contains names/placeholders only.
