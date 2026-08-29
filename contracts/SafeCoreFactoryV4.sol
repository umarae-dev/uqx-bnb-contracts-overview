// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./SafeCoreAccountV4.sol";

/// @title SafeCoreFactoryV4
/// @notice EXPERIMENTAL gasless account factory. NOT AUDITED.
/// @dev An arbitrary relayer may pay deployment gas, but the recovery identity
///      must EIP-712-sign the exact immutable/initial SafeCore configuration.
contract SafeCoreFactoryV4 is EIP712 {
    using ECDSA for bytes32;

    bytes32 private constant CREATE_TYPEHASH = keccak256(
        "CreateSafeCore(address identity,bytes32 configHash,uint256 nonce,uint256 deadline)"
    );

    mapping(address => address) public accountOf;
    mapping(address => uint256) public creationNonce;

    event SafeCoreAccountCreated(address indexed identity, address indexed account, address indexed relayer, bytes32 configHash);

    error AccountAlreadyExists();
    error ZeroAddress();
    error SignatureExpired();
    error InvalidSignature();

    constructor() EIP712("SafeCoreFactoryV4", "1") {}

    function createAccountFor(
        address identity,
        address initialDevice,
        address emergencyAddress1,
        address emergencyAddress2,
        bytes32 recoveryCommitment,
        uint64 destinationChangeDelay,
        address[] calldata initialAssets,
        uint192[] calldata initialLimits,
        uint256 deadline,
        bytes calldata identitySignature
    ) external returns (address account) {
        if (identity == address(0)) revert ZeroAddress();
        if (accountOf[identity] != address(0)) revert AccountAlreadyExists();
        if (deadline < block.timestamp) revert SignatureExpired();

        bytes32 configHash = configurationHash(
            initialDevice,
            emergencyAddress1,
            emergencyAddress2,
            recoveryCommitment,
            destinationChangeDelay,
            initialAssets,
            initialLimits
        );
        uint256 nonce = creationNonce[identity]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            CREATE_TYPEHASH, identity, configHash, nonce, deadline
        )));
        if (digest.recover(identitySignature) != identity) revert InvalidSignature();

        SafeCoreAccountV4 created = new SafeCoreAccountV4(
            identity,
            initialDevice,
            emergencyAddress1,
            emergencyAddress2,
            recoveryCommitment,
            destinationChangeDelay,
            initialAssets,
            initialLimits
        );
        account = address(created);
        accountOf[identity] = account;
        emit SafeCoreAccountCreated(identity, account, msg.sender, configHash);
    }

    function configurationHash(
        address initialDevice,
        address emergencyAddress1,
        address emergencyAddress2,
        bytes32 recoveryCommitment,
        uint64 destinationChangeDelay,
        address[] calldata initialAssets,
        uint192[] calldata initialLimits
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(
            initialDevice,
            emergencyAddress1,
            emergencyAddress2,
            recoveryCommitment,
            destinationChangeDelay,
            initialAssets,
            initialLimits
        ));
    }

    function createDigest(address identity, bytes32 configHash, uint256 nonce, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CREATE_TYPEHASH, identity, configHash, nonce, deadline)));
    }
}
