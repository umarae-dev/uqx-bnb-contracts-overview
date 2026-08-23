// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

// No logic here — this file exists purely so Hardhat compiles
// TimelockController (an OpenZeppelin library contract we deploy directly
// via scripts/uqx/deploy.js and reference in tests, but never inherit from
// in our own contracts) and generates an artifact for it. Without an
// import somewhere under contracts/, Hardhat has no reason to compile it.
import "@openzeppelin/contracts/governance/TimelockController.sol";

// ERC20PresetFixedSupply stands in for real USDT/USDC (both 18 decimals on
// BSC, verified on-chain) in UqxPresale's local tests — never deployed to
// any live network, test-only.
import "@openzeppelin/contracts/token/ERC20/presets/ERC20PresetFixedSupply.sol";
