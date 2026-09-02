// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "./SafeCoreAccountV4_2.sol";

interface ISafeCoreRecoveryStateV4 {
    function recoveryCommitment() external view returns (bytes32);
    function successorConfigHash() external view returns (bytes32);
}

/// @title SafeCoreFactoryV4
/// @notice EXPERIMENTAL gasless account factory. NOT AUDITED.
/// @dev Any relayer may pay deployment gas, but the recovery identity signs the
///      exact configuration hash. Replacement creation is permitted only when
///      the retired predecessor committed that exact same config hash during the
///      terminal Recovery Card rescue.
contract SafeCoreFactoryV4 is EIP712 {
    using ECDSA for bytes32;

    bytes32 private constant CREATE_TYPEHASH = keccak256(
        "CreateSafeCore(address identity,bytes32 configHash,uint256 nonce,uint256 deadline)"
    );

    struct AccountConfig {
        address initialDevice;
        address emergencyAddress1;
        address emergencyAddress2;
        bytes32 recoveryCommitment;
        uint64 destinationChangeDelay;
        address[] initialAssets;
        uint192[] initialLimits;
    }

    mapping(address => address) public accountOf;
    mapping(address => uint256) public creationNonce;

    event SafeCoreAccountCreated(address indexed identity, address indexed account, address indexed relayer, bytes32 configHash);

    error AccountAlreadyExists();
    error ReplacementConfigMismatch();
    error ZeroAddress();
    error SignatureExpired();
    error InvalidSignature();

    constructor() EIP712("SafeCoreFactoryV4", "1") {}

    function createAccountFor(
        address identity,
        AccountConfig calldata config,
        uint256 deadline,
        bytes calldata identitySignature
    ) external returns (address account) {
        if (identity == address(0)) revert ZeroAddress();
        if (deadline < block.timestamp) revert SignatureExpired();

        bytes32 configHash = configurationHash(config);
        address previous = accountOf[identity];
        if (previous != address(0)) {
            ISafeCoreRecoveryStateV4 predecessor = ISafeCoreRecoveryStateV4(previous);
            if (predecessor.recoveryCommitment() != bytes32(0)) revert AccountAlreadyExists();
            if (predecessor.successorConfigHash() != configHash) revert ReplacementConfigMismatch();
        }

        uint256 nonce = creationNonce[identity]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            CREATE_TYPEHASH, identity, configHash, nonce, deadline
        )));
        if (digest.recover(identitySignature) != identity) revert InvalidSignature();

        SafeCoreAccountV4_1.InitConfig memory init = SafeCoreAccountV4_1.InitConfig({
            initialDevice: config.initialDevice,
            emergencyAddress1: config.emergencyAddress1,
            emergencyAddress2: config.emergencyAddress2,
            recoveryCommitment: config.recoveryCommitment,
            destinationChangeDelay: config.destinationChangeDelay,
            initialAssets: config.initialAssets,
            initialLimits: config.initialLimits
        });

        SafeCoreAccountV4_2 created = new SafeCoreAccountV4_2(identity, init);
        account = address(created);
        accountOf[identity] = account;
        emit SafeCoreAccountCreated(identity, account, msg.sender, configHash);
    }

    function configurationHash(AccountConfig calldata config) public pure returns (bytes32) {
        return keccak256(abi.encode(
            config.initialDevice,
            config.emergencyAddress1,
            config.emergencyAddress2,
            config.recoveryCommitment,
            config.destinationChangeDelay,
            config.initialAssets,
            config.initialLimits
        ));
    }
}
