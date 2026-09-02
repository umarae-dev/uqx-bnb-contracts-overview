// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "./SafeCoreAccountV4_1.sol";

/// @title SafeCoreAccountV4_2
/// @notice Pre-deployment V4 hardening revision adding an explicit signed veto
///         for delayed emergency-destination changes.
/// @dev Preserves the SafeCoreAccountV4 EIP-712 domain/version inherited from
///      V4.1 so existing client signatures remain compatible.
contract SafeCoreAccountV4_2 is SafeCoreAccountV4_1 {
    bytes32 private constant CANCEL_DESTINATIONS_TYPEHASH = keccak256(
        "CancelEmergencyDestinations(address account,address device,uint256 nonce,uint256 deadline)"
    );

    event EmergencyDestinationsChangeCancelled(address indexed approvedBy);

    constructor(address identity_, SafeCoreAccountV4_1.InitConfig memory config)
        SafeCoreAccountV4_1(identity_, config)
    {}

    /// @notice Any currently authorized trusted device can veto a queued
    ///         security weakening during the delay window. The call is gasless
    ///         through the relayer but the relayer has no authority itself.
    function cancelEmergencyDestinationsChange(
        address device,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (!authorizedDevice(device)) revert NotAuthorized();
        (,, uint64 executableAt) = pendingEmergencyDestinations();
        if (executableAt == 0) revert DestinationChangeMissing();
        if (deadline < block.timestamp) revert SignatureExpired();

        uint256 nonce = deviceNonce(device);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            CANCEL_DESTINATIONS_TYPEHASH, address(this), device, nonce, deadline
        )));
        if (digest.recover(signature) != device) revert InvalidSignature();

        // Increment through the inherited public mapping's generated getter is
        // not writable, so this revision delegates nonce consumption to a tiny
        // internal hook exposed by V4.1 hardening.
        _consumeDeviceNonceV42(device, nonce);
        _clearPendingDestinationsV42();
        emit EmergencyDestinationsChangeCancelled(device);
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
}
