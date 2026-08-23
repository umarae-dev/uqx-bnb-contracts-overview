// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title UQX Token
/// @notice Fixed-supply BEP-20 utility token reference used by the UQX ecosystem.
/// @dev Supply is minted once to treasury. No owner, mint, pause, blacklist or
/// privileged balance-management functions exist after deployment.
contract UqxToken is ERC20 {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 10 ** 18;

    constructor(address treasury) ERC20("Zynost UQX", "UQX") {
        require(treasury != address(0), "UqxToken: treasury is zero address");
        _mint(treasury, TOTAL_SUPPLY);
    }
}
