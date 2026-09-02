// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./SafeCoreAccountV4_1.sol";

/// @title SafeCoreAccountV4_2
/// @notice Pre-deployment V4 hardening revision adding explicit signed vetoes
///         for delayed security weakening.
/// @dev Preserves the SafeCoreAccountV4 EIP-712 domain/version inherited from
///      V4.1 so existing client signatures remain compatible.
contract SafeCoreAccountV4_2 is SafeCoreAccountV4_1 {
    using ECDSA for bytes32;

    bytes32 private constant CANCEL_DESTINATIONS_TYPEHASH = keccak256(
        "CancelEmergencyDestinations(address account,address device,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant CANCEL_BUDGET_TYPEHASH = keccak256(
        "CancelBudgetIncrease(address account,address device,address asset,uint256 nonce,uint256 deadline)"
    );

    event EmergencyDestinationsChangeCancelled(address indexed approvedBy);
    event DelayedBudgetIncreaseCancelled(address indexed asset, address indexed approvedBy);

    constructor(address identity_, SafeCoreAccountV4_1.InitConfig memory config)
        SafeCoreAccountV4_1(identity_, config)
    {}

    /// @notice Any currently authorized trusted device can veto a queued
    ///         emergency-destination weakening during the delay window.
    function cancelEmergencyDestinationsChange(
        address device,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (!authorizedDevice[device]) revert NotAuthorized();
        if (pendingEmergencyDestinations.executableAt == 0) revert DestinationChangeMissing();
        if (deadline < block.timestamp) revert SignatureExpired();

        uint256 nonce = deviceNonce[device]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            CANCEL_DESTINATIONS_TYPEHASH, address(this), device, nonce, deadline
        )));
        if (digest.recover(signature) != device) revert InvalidSignature();

        delete pendingEmergencyDestinations;
        emit EmergencyDestinationsChangeCancelled(device);
    }

    /// @notice Cancels a queued budget increase even when the current budget is
    ///         already zero. This closes the edge case where "reduce to cancel"
    ///         cannot tighten the budget any further.
    function cancelBudgetIncrease(
        address device,
        address asset,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (!authorizedDevice[device]) revert NotAuthorized();
        if (pendingBudgetChange[asset].executableAt == 0) revert BudgetIncreaseMissing();
        if (deadline < block.timestamp) revert SignatureExpired();

        uint256 nonce = deviceNonce[device]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            CANCEL_BUDGET_TYPEHASH, address(this), device, asset, nonce, deadline
        )));
        if (digest.recover(signature) != device) revert InvalidSignature();

        delete pendingBudgetChange[asset];
        emit DelayedBudgetIncreaseCancelled(asset, device);
    }

    function cancelEmergencyDestinationsDigest(
        address device,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            CANCEL_DESTINATIONS_TYPEHASH, address(this), device, nonce, deadline
        )));
    }

    function cancelBudgetIncreaseDigest(
        address device,
        address asset,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            CANCEL_BUDGET_TYPEHASH, address(this), device, asset, nonce, deadline
        )));
    }
}
