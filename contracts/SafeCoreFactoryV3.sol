// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "./SafeCoreAccountV3.sol";

/// @title SafeCoreFactoryV3
/// @notice EXPERIMENTAL one-account-per-identity factory for SafeCore V3.
/// @dev NOT AUDITED. DO NOT DEPLOY WITH PRODUCTION FUNDS.
///
/// The factory exists so a fresh installation that only knows the standard
/// seed/private-key-derived identity can discover its SafeCore account through
/// `accountOf(identity)`. The factory never receives or stores recovery secrets.
contract SafeCoreFactoryV3 {
    mapping(address identity => address account) public accountOf;

    event SafeCoreAccountCreated(
        address indexed identity,
        address indexed account,
        address indexed initialDevice,
        address emergencyAddress1,
        address emergencyAddress2
    );

    error AccountAlreadyExists();
    error ZeroAddress();

    /// @notice Creates the caller's SafeCore account. The caller is the recovery
    /// identity; protected funds are still spendable only by authorized devices
    /// inside SafeCoreAccountV3.
    function createMyAccount(
        address initialDevice,
        address emergencyAddress1,
        address emergencyAddress2,
        bytes32 recoveryCommitment,
        uint64 emergencyDestinationChangeDelay,
        address[] calldata initialAssets,
        uint192[] calldata initialLimits
    ) external returns (address account) {
        if (msg.sender == address(0) || initialDevice == address(0)) revert ZeroAddress();
        if (accountOf[msg.sender] != address(0)) revert AccountAlreadyExists();

        SafeCoreAccountV3 created = new SafeCoreAccountV3(
            msg.sender,
            initialDevice,
            emergencyAddress1,
            emergencyAddress2,
            recoveryCommitment,
            emergencyDestinationChangeDelay,
            initialAssets,
            initialLimits
        );
        account = address(created);
        accountOf[msg.sender] = account;

        emit SafeCoreAccountCreated(
            msg.sender,
            account,
            initialDevice,
            emergencyAddress1,
            emergencyAddress2
        );
    }
}
