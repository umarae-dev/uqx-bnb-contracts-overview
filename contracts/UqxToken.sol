// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title UQX Token
/// @notice Fixed-supply BEP-20 utility token for the Zynost ecosystem.
/// @dev The entire supply is minted once, in the constructor, to the
/// treasury address. There is no mint function anywhere in this contract,
/// no owner, no pause, no blacklist — supply can never increase and no
/// address (including the deployer) has any privileged power over anyone
/// else's balance after deployment. This is deliberate: the fewer
/// privileged functions a token contract has, the less there is for a bug
/// or a compromised key to go wrong with.
contract UqxToken is ERC20 {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 10 ** 18;

    constructor(address treasury) ERC20("Zynost UQX", "UQX") {
        require(treasury != address(0), "UqxToken: treasury is zero address");
        _mint(treasury, TOTAL_SUPPLY);
    }
}
