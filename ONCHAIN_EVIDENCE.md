# UQX BNB Smart Chain On-Chain Evidence

This file is the canonical transaction-evidence page for the UQX token, presale, vesting and governance deployment on BNB Smart Chain.

For canonical deployed addresses and funded-state documentation, see [`DEPLOYMENTS.md`](DEPLOYMENTS.md). This file focuses on successful public mainnet transactions so the same transaction detail does not need to be repeated in unrelated Zynost repositories.

> **Historical terminology:** the deployed vesting source retains `AllocationType.Mining` for source/ABI compatibility. Current UQX product branding is the self-custody Web3 wallet. This evidence page therefore calls that funded bucket the **historical distribution pool** except when quoting the exact Solidity identifier.

## Network

- BNB Smart Chain mainnet
- Chain ID: `56`
- UQX production deployment date documented in this repository: **18 August 2026**

## Presale purchase proof

Transaction:

`0xc8577b9043c1c8f1c8e89907c80a238d080afea114af050c83b86453b04e0238`

Explorer:

https://bscscan.com/tx/0xc8577b9043c1c8f1c8e89907c80a238d080afea114af050c83b86453b04e0238

Recorded facts:

- status: success;
- block: `116626859`;
- time: `2026-08-18 08:47:31 UTC`;
- call: UQX Presale `buy(address,uint256)`;
- payment asset: BSC USDT `0x55d398326f99059ff775485246999027b3197955`;
- paid: **1 USDT**;
- resulting allocation: **200 UQX**.

## Presale payment-token configuration

Successful configuration transaction:

`0x2968e14c1781b94e32aa1715dd38486001417c8400b1fe1453d9917bfafc599a`

Explorer:

https://bscscan.com/tx/0x2968e14c1781b94e32aa1715dd38486001417c8400b1fe1453d9917bfafc599a

Second successful payment-token configuration transaction:

`0x99c073cd0ac057a03ae0d9582dca95da60436b5eb659bdfe376cbb1df243590c`

Explorer:

https://bscscan.com/tx/0x99c073cd0ac057a03ae0d9582dca95da60436b5eb659bdfe376cbb1df243590c

## Presale deployment

Transaction:

`0x5d781e7aa9e7b4b26beac140b36f0a524b9c100f9dd0a3a29da01b17b5a83e93`

Explorer:

https://bscscan.com/tx/0x5d781e7aa9e7b4b26beac140b36f0a524b9c100f9dd0a3a29da01b17b5a83e93

## Governance handoff

Transaction:

`0xa60cd2c97f6944a5b64b7a40bc2aee0dc20754bdb343597a1698356a224e3a17`

Explorer:

https://bscscan.com/tx/0xa60cd2c97f6944a5b64b7a40bc2aee0dc20754bdb343597a1698356a224e3a17

This is part of the documented timelock/Safe governance path. Current governance state and addresses belong in [`DEPLOYMENTS.md`](DEPLOYMENTS.md).

## Historical distribution-pool funding

Transaction:

`0xd7b7d5bc4d927e4df29fe56a079deada0ac560505990d24e6ddd112048caf5cf`

Explorer:

https://bscscan.com/tx/0xd7b7d5bc4d927e4df29fe56a079deada0ac560505990d24e6ddd112048caf5cf

The transaction records successful funding of the deployed UQX Vesting pool. The documented funded amount and the distinction between funded pools and remaining treasury-held supply are maintained in [`DEPLOYMENTS.md`](DEPLOYMENTS.md).

## Verification boundary

These hashes and contract addresses are public blockchain data. No customer identity, private key, recovery phrase, production credential, unpublished Merkle allocation dataset or private operational record belongs in this file.

Independently verify each transaction and current contract state on a BNB Smart Chain explorer before relying on it.
