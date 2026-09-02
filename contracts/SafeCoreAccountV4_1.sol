// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title SafeCoreAccountV4_1
/// @notice Hardened V4 implementation candidate. EXPERIMENTAL / NOT AUDITED.
/// @dev Relayers pay gas but are never authority. Normal value movement requires
///      an authorized device signature. Lost-phone rescue requires the recovery
///      identity signature + a one-time paper secret and remains restricted to
///      the two pre-registered emergency destinations.
contract SafeCoreAccountV4_1 is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    address public constant NATIVE_ASSET = address(0);
    uint64 public constant EPOCH_SECONDS = 1 days;
    uint256 public constant MAX_RESCUE_ITEMS = 32;
    uint256 public constant MAX_INITIAL_ASSETS = 64;

    bytes32 private constant ENROLL_TYPEHASH = keccak256(
        "EnrollDevice(address account,address newDevice,bytes32 pairingHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant APPROVE_TYPEHASH = keccak256(
        "ApproveDevice(address account,address newDevice,bytes32 pairingHash,uint256 enrollmentNonce,uint256 deadline)"
    );
    bytes32 private constant SPEND_TYPEHASH = keccak256(
        "DeviceSpend(address account,address device,address asset,address to,uint256 amount,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant RESCUE_TYPEHASH = keccak256(
        "EmergencyRescue(address account,address identity,bytes32 rescueHash,uint256 recoveryGeneration,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant DESTINATIONS_TYPEHASH = keccak256(
        "ChangeEmergencyDestinations(address account,address device,address first,address second,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant REVOKE_TYPEHASH = keccak256(
        "RevokeDevice(address account,address device,address target,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant ARM_RECOVERY_TYPEHASH = keccak256(
        "ArmRecovery(address account,address device,bytes32 commitment,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant BUDGET_TYPEHASH = keccak256(
        "ChangeBudget(address account,address device,address asset,uint256 newLimit,uint256 nonce,uint256 deadline)"
    );

    address public immutable identity;
    uint64 public immutable emergencyDestinationChangeDelay;
    uint64 public immutable budgetIncreaseDelay;

    mapping(address => bool) public authorizedDevice;
    mapping(address => uint256) public deviceNonce;
    uint256 public authorizedDeviceCount;
    uint256 public identityNonce;
    uint256 public enrollmentNonce;

    // Enumerable trusted-device registry. The mapping remains the authority;
    // this registry exists so clients can reliably display and revoke devices.
    address[] private _authorizedDevices;
    mapping(address => uint256) private _authorizedDeviceIndexPlusOne;

    address public emergencyAddress1;
    address public emergencyAddress2;
    bytes32 public recoveryCommitment;
    uint256 public recoveryGeneration;

    struct InitConfig {
        address initialDevice;
        address emergencyAddress1;
        address emergencyAddress2;
        bytes32 recoveryCommitment;
        uint64 destinationChangeDelay;
        address[] initialAssets;
        uint192[] initialLimits;
    }

    struct Budget {
        uint192 limit;
        uint192 spent;
        uint64 epochStartedAt;
    }
    struct PendingEnrollment {
        bytes32 pairingHash;
        uint256 nonce;
        uint64 requestedAt;
    }
    struct PendingDestinations {
        address first;
        address second;
        uint64 executableAt;
    }
    struct PendingBudgetChange {
        uint192 newLimit;
        uint64 executableAt;
    }

    mapping(address => Budget) private _budgets;
    mapping(address => PendingEnrollment) public pendingEnrollment;
    mapping(address => PendingBudgetChange) public pendingBudgetChange;
    PendingDestinations public pendingEmergencyDestinations;

    event Deposited(address indexed sender, uint256 amount);
    event RelayedSpend(address indexed relayer, address indexed device, address indexed asset, address to, uint256 amount, uint256 nonce);
    event DeviceEnrollmentRequested(address indexed newDevice, bytes32 indexed pairingHash, uint256 indexed nonce);
    event DeviceActivated(address indexed newDevice, address indexed approvingDevice);
    event DeviceRevoked(address indexed device, address indexed approvedBy);
    event EmergencyRescueExecuted(address indexed relayer, uint256 indexed generation, address indexed destination, address asset, uint256 amount);
    event RecoveryCommitmentArmed(bytes32 indexed commitment, uint256 indexed generation, address indexed approvedBy);
    event EmergencyDestinationsChangeRequested(address indexed first, address indexed second, uint256 executableAt, address approvedBy);
    event EmergencyDestinationsChanged(address indexed first, address indexed second);
    event BudgetReduced(address indexed asset, uint256 oldLimit, uint256 newLimit);
    event BudgetIncreaseRequested(address indexed asset, uint256 oldLimit, uint256 newLimit, uint256 executableAt, address approvedBy);
    event BudgetIncreaseApplied(address indexed asset, uint256 oldLimit, uint256 newLimit);
    event BudgetIncreaseCancelled(address indexed asset, address indexed approvedBy);

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidSignature();
    error SignatureExpired();
    error InvalidDelay();
    error AlreadyAuthorized();
    error NotAuthorized();
    error LastDevice();
    error EnrollmentMissing();
    error PairingMismatch();
    error InvalidRecoverySecret();
    error RecoveryNotArmed();
    error RecoveryAlreadyArmed();
    error EmergencyDestinationOnly();
    error InvalidEmergencyDestinations();
    error DestinationChangeMissing();
    error DestinationChangeNotReady();
    error ArrayLengthMismatch();
    error TooManyItems();
    error InsufficientBalance();
    error BudgetExceeded();
    error BudgetNotReduced();
    error BudgetUnchanged();
    error BudgetIncreaseMissing();
    error BudgetIncreaseNotReady();
    error DuplicateAsset();
    error AmountTooLarge();
    error NativeTransferFailed();
    error DeviceRegistryCorrupt();

    constructor(address identity_, InitConfig memory config) EIP712("SafeCoreAccountV4", "1") {
        if (identity_ == address(0) || config.initialDevice == address(0)) revert ZeroAddress();
        _validateDestinations(config.emergencyAddress1, config.emergencyAddress2);
        if (config.recoveryCommitment == bytes32(0)) revert RecoveryNotArmed();
        if (config.destinationChangeDelay < 1 days || config.destinationChangeDelay > 30 days) revert InvalidDelay();
        if (config.initialAssets.length != config.initialLimits.length) revert ArrayLengthMismatch();
        if (config.initialAssets.length > MAX_INITIAL_ASSETS) revert TooManyItems();

        identity = identity_;
        emergencyAddress1 = config.emergencyAddress1;
        emergencyAddress2 = config.emergencyAddress2;
        recoveryCommitment = config.recoveryCommitment;
        recoveryGeneration = 1;
        emergencyDestinationChangeDelay = config.destinationChangeDelay;
        budgetIncreaseDelay = config.destinationChangeDelay;
        _addAuthorizedDevice(config.initialDevice);

        uint64 nowTs = uint64(block.timestamp);
        for (uint256 i; i < config.initialAssets.length; ++i) {
            address asset = config.initialAssets[i];
            for (uint256 j; j < i; ++j) {
                if (config.initialAssets[j] == asset) revert DuplicateAsset();
            }
            _budgets[asset] = Budget(config.initialLimits[i], 0, nowTs);
        }
    }

    receive() external payable { emit Deposited(msg.sender, msg.value); }

    // ---------------------- gasless device enrollment ----------------------

    function requestDeviceEnrollment(
        address newDevice,
        bytes32 pairingHash,
        uint256 deadline,
        bytes calldata identitySignature,
        bytes calldata newDeviceSignature
    ) external {
        if (newDevice == address(0)) revert ZeroAddress();
        if (authorizedDevice[newDevice]) revert AlreadyAuthorized();
        if (pairingHash == bytes32(0)) revert PairingMismatch();
        _checkDeadline(deadline);

        uint256 nonce = enrollmentNonce++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            ENROLL_TYPEHASH, address(this), newDevice, pairingHash, nonce, deadline
        )));
        if (digest.recover(identitySignature) != identity) revert InvalidSignature();
        if (digest.recover(newDeviceSignature) != newDevice) revert InvalidSignature();

        pendingEnrollment[newDevice] = PendingEnrollment(pairingHash, nonce, uint64(block.timestamp));
        emit DeviceEnrollmentRequested(newDevice, pairingHash, nonce);
    }

    function activateDeviceWithApproval(
        address newDevice,
        bytes32 pairingHash,
        address approvingDevice,
        uint256 deadline,
        bytes calldata approvalSignature
    ) external {
        PendingEnrollment memory p = pendingEnrollment[newDevice];
        if (p.requestedAt == 0) revert EnrollmentMissing();
        if (p.pairingHash != pairingHash) revert PairingMismatch();
        if (!authorizedDevice[approvingDevice]) revert NotAuthorized();
        _checkDeadline(deadline);

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            APPROVE_TYPEHASH, address(this), newDevice, pairingHash, p.nonce, deadline
        )));
        if (digest.recover(approvalSignature) != approvingDevice) revert InvalidSignature();

        _addAuthorizedDevice(newDevice);
        delete pendingEnrollment[newDevice];
        emit DeviceActivated(newDevice, approvingDevice);
    }

    // ------------------------- gasless spending ----------------------------

    function relaySpend(
        address device,
        address asset,
        address payable to,
        uint256 amount,
        uint256 deadline,
        bytes calldata deviceSignature
    ) external nonReentrant {
        if (!authorizedDevice[device]) revert NotAuthorized();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _checkDeadline(deadline);

        uint256 nonce = deviceNonce[device]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            SPEND_TYPEHASH, address(this), device, asset, to, amount, nonce, deadline
        )));
        if (digest.recover(deviceSignature) != device) revert InvalidSignature();

        _consumeBudget(asset, amount);
        if (asset == NATIVE_ASSET) {
            if (amount > address(this).balance) revert InsufficientBalance();
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20 token = IERC20(asset);
            if (amount > token.balanceOf(address(this))) revert InsufficientBalance();
            token.safeTransfer(to, amount);
        }
        emit RelayedSpend(msg.sender, device, asset, to, amount, nonce);
    }

    // ----------------------- gasless lost-phone rescue ---------------------

    function emergencyRescue(
        bytes32 paperSecret,
        address[] calldata assets,
        uint256[] calldata amounts,
        address[] calldata destinations,
        uint256 deadline,
        bytes calldata identitySignature
    ) external nonReentrant {
        uint256 length = assets.length;
        if (length == 0 || length != amounts.length || length != destinations.length) revert ArrayLengthMismatch();
        if (length > MAX_RESCUE_ITEMS) revert TooManyItems();
        _checkDeadline(deadline);
        if (recoveryCommitment == bytes32(0)) revert RecoveryNotArmed();
        if (keccak256(abi.encodePacked(paperSecret)) != recoveryCommitment) revert InvalidRecoverySecret();

        for (uint256 i; i < length; ++i) {
            if (!_isEmergencyDestination(destinations[i])) revert EmergencyDestinationOnly();
            if (amounts[i] == 0) revert ZeroAmount();
        }

        bytes32 rescueHash = keccak256(abi.encode(assets, amounts, destinations));
        uint256 nonce = identityNonce++;
        uint256 generation = recoveryGeneration;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            RESCUE_TYPEHASH, address(this), identity, rescueHash, generation, nonce, deadline
        )));
        if (digest.recover(identitySignature) != identity) revert InvalidSignature();

        // Burn before external interactions. Any revert restores it atomically.
        recoveryCommitment = bytes32(0);

        for (uint256 i; i < length; ++i) {
            address asset = assets[i];
            address to = destinations[i];
            uint256 requested = amounts[i];
            uint256 amount;
            if (asset == NATIVE_ASSET) {
                uint256 available = address(this).balance;
                amount = requested == type(uint256).max ? available : requested;
                if (amount == 0 || amount > available) revert InsufficientBalance();
                (bool ok,) = payable(to).call{value: amount}("");
                if (!ok) revert NativeTransferFailed();
            } else {
                IERC20 token = IERC20(asset);
                uint256 available = token.balanceOf(address(this));
                amount = requested == type(uint256).max ? available : requested;
                if (amount == 0 || amount > available) revert InsufficientBalance();
                token.safeTransfer(to, amount);
            }
            emit EmergencyRescueExecuted(msg.sender, generation, to, asset, amount);
        }
    }

    // --------------------- gasless security management ---------------------

    function requestEmergencyDestinationsChange(
        address device,
        address first,
        address second,
        uint256 deadline,
        bytes calldata deviceSignature
    ) external {
        _validateDestinations(first, second);
        if (!authorizedDevice[device]) revert NotAuthorized();
        _checkDeadline(deadline);
        uint256 nonce = deviceNonce[device]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            DESTINATIONS_TYPEHASH, address(this), device, first, second, nonce, deadline
        )));
        if (digest.recover(deviceSignature) != device) revert InvalidSignature();

        uint64 executableAt = uint64(block.timestamp) + emergencyDestinationChangeDelay;
        pendingEmergencyDestinations = PendingDestinations(first, second, executableAt);
        emit EmergencyDestinationsChangeRequested(first, second, executableAt, device);
    }

    function applyEmergencyDestinationsChange() external {
        PendingDestinations memory p = pendingEmergencyDestinations;
        if (p.executableAt == 0) revert DestinationChangeMissing();
        if (block.timestamp < p.executableAt) revert DestinationChangeNotReady();
        emergencyAddress1 = p.first;
        emergencyAddress2 = p.second;
        delete pendingEmergencyDestinations;
        emit EmergencyDestinationsChanged(p.first, p.second);
    }

    function relayRevokeDevice(
        address approvingDevice,
        address target,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (!authorizedDevice[approvingDevice] || !authorizedDevice[target]) revert NotAuthorized();
        if (authorizedDeviceCount <= 1) revert LastDevice();
        _checkDeadline(deadline);
        uint256 nonce = deviceNonce[approvingDevice]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            REVOKE_TYPEHASH, address(this), approvingDevice, target, nonce, deadline
        )));
        if (digest.recover(signature) != approvingDevice) revert InvalidSignature();
        _removeAuthorizedDevice(target);
        emit DeviceRevoked(target, approvingDevice);
    }

    /// @notice Arms a new one-time Recovery Card only after the previous card
    ///         has been consumed by emergency rescue. An authorized stolen phone
    ///         cannot silently replace a still-valid recovery commitment.
    function relayArmRecovery(
        address device,
        bytes32 commitment,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (commitment == bytes32(0)) revert RecoveryNotArmed();
        if (recoveryCommitment != bytes32(0)) revert RecoveryAlreadyArmed();
        if (!authorizedDevice[device]) revert NotAuthorized();
        _checkDeadline(deadline);
        uint256 nonce = deviceNonce[device]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            ARM_RECOVERY_TYPEHASH, address(this), device, commitment, nonce, deadline
        )));
        if (digest.recover(signature) != device) revert InvalidSignature();
        recoveryCommitment = commitment;
        recoveryGeneration += 1;
        emit RecoveryCommitmentArmed(commitment, recoveryGeneration, device);
    }

    /// @notice Signed budget policy. Tightening applies immediately. Relaxing a
    /// limit is delayed by the same immutable security delay chosen at account
    /// creation. A later signed tightening also cancels any pending increase.
    function requestBudgetChange(
        address device,
        address asset,
        uint192 newLimit,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (!authorizedDevice[device]) revert NotAuthorized();
        _checkDeadline(deadline);
        uint256 nonce = deviceNonce[device]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            BUDGET_TYPEHASH, address(this), device, asset, uint256(newLimit), nonce, deadline
        )));
        if (digest.recover(signature) != device) revert InvalidSignature();

        _rollEpoch(asset);
        Budget storage b = _budgets[asset];
        uint192 oldLimit = b.limit;
        if (newLimit == oldLimit) revert BudgetUnchanged();

        if (newLimit < oldLimit) {
            b.limit = newLimit;
            delete pendingBudgetChange[asset];
            emit BudgetReduced(asset, oldLimit, newLimit);
            emit BudgetIncreaseCancelled(asset, device);
        } else {
            uint64 executableAt = uint64(block.timestamp) + budgetIncreaseDelay;
            pendingBudgetChange[asset] = PendingBudgetChange(newLimit, executableAt);
            emit BudgetIncreaseRequested(asset, oldLimit, newLimit, executableAt, device);
        }
    }

    function applyBudgetIncrease(address asset) external {
        PendingBudgetChange memory p = pendingBudgetChange[asset];
        if (p.executableAt == 0) revert BudgetIncreaseMissing();
        if (block.timestamp < p.executableAt) revert BudgetIncreaseNotReady();
        _rollEpoch(asset);
        Budget storage b = _budgets[asset];
        uint192 oldLimit = b.limit;
        if (p.newLimit <= oldLimit) {
            delete pendingBudgetChange[asset];
            revert BudgetNotReduced();
        }
        b.limit = p.newLimit;
        delete pendingBudgetChange[asset];
        emit BudgetIncreaseApplied(asset, oldLimit, p.newLimit);
    }

    function reduceBudgetImmediately(address asset, uint192 newLimit) external {
        if (!authorizedDevice[msg.sender]) revert Unauthorized();
        _rollEpoch(asset);
        Budget storage b = _budgets[asset];
        if (newLimit >= b.limit) revert BudgetNotReduced();
        uint192 old = b.limit;
        b.limit = newLimit;
        delete pendingBudgetChange[asset];
        emit BudgetReduced(asset, old, newLimit);
        emit BudgetIncreaseCancelled(asset, msg.sender);
    }

    // ------------------------------- views ---------------------------------

    function budgetOf(address asset) external view returns (uint256 limit, uint256 spent, uint256 remaining, uint256 epochStartedAt) {
        Budget memory b = _budgets[asset];
        uint192 effectiveSpent = _effectiveSpent(b);
        return (b.limit, effectiveSpent, b.limit > effectiveSpent ? uint256(b.limit - effectiveSpent) : 0, _effectiveEpochStart(b));
    }

    function authorizedDevices() external view returns (address[] memory) {
        return _authorizedDevices;
    }

    function authorizedDeviceAt(uint256 index) external view returns (address) {
        return _authorizedDevices[index];
    }

    function isEmergencyDestination(address candidate) external view returns (bool) { return _isEmergencyDestination(candidate); }

    function enrollmentDigest(address newDevice, bytes32 pairingHash, uint256 nonce, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ENROLL_TYPEHASH, address(this), newDevice, pairingHash, nonce, deadline)));
    }

    function spendDigest(address device, address asset, address to, uint256 amount, uint256 nonce, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(SPEND_TYPEHASH, address(this), device, asset, to, amount, nonce, deadline)));
    }

    function budgetChangeDigest(address device, address asset, uint192 newLimit, uint256 nonce, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(BUDGET_TYPEHASH, address(this), device, asset, uint256(newLimit), nonce, deadline)));
    }

    function rescuePayloadHash(address[] calldata assets, uint256[] calldata amounts, address[] calldata destinations) external pure returns (bytes32) {
        return keccak256(abi.encode(assets, amounts, destinations));
    }

    // ----------------------------- internals -------------------------------

    function _addAuthorizedDevice(address device) private {
        if (device == address(0)) revert ZeroAddress();
        if (authorizedDevice[device]) revert AlreadyAuthorized();
        authorizedDevice[device] = true;
        _authorizedDevices.push(device);
        _authorizedDeviceIndexPlusOne[device] = _authorizedDevices.length;
        authorizedDeviceCount = _authorizedDevices.length;
    }

    function _removeAuthorizedDevice(address device) private {
        uint256 indexPlusOne = _authorizedDeviceIndexPlusOne[device];
        if (indexPlusOne == 0 || !authorizedDevice[device]) revert DeviceRegistryCorrupt();
        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = _authorizedDevices.length - 1;
        if (index != lastIndex) {
            address moved = _authorizedDevices[lastIndex];
            _authorizedDevices[index] = moved;
            _authorizedDeviceIndexPlusOne[moved] = index + 1;
        }
        _authorizedDevices.pop();
        delete _authorizedDeviceIndexPlusOne[device];
        authorizedDevice[device] = false;
        authorizedDeviceCount = _authorizedDevices.length;
    }

    function _checkDeadline(uint256 deadline) private view {
        if (deadline < block.timestamp) revert SignatureExpired();
    }

    function _validateDestinations(address first, address second) private view {
        if (first == address(0) || second == address(0) || first == second || first == address(this) || second == address(this)) {
            revert InvalidEmergencyDestinations();
        }
    }

    function _isEmergencyDestination(address candidate) private view returns (bool) {
        return candidate == emergencyAddress1 || candidate == emergencyAddress2;
    }

    function _consumeBudget(address asset, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint192).max) revert AmountTooLarge();
        _rollEpoch(asset);
        Budget storage b = _budgets[asset];
        uint256 next = uint256(b.spent) + amount;
        if (next > b.limit) revert BudgetExceeded();
        b.spent = uint192(next);
    }

    function _rollEpoch(address asset) private {
        Budget storage b = _budgets[asset];
        if (b.epochStartedAt == 0) {
            b.epochStartedAt = uint64(block.timestamp);
        } else if (block.timestamp >= uint256(b.epochStartedAt) + EPOCH_SECONDS) {
            b.epochStartedAt = uint64(block.timestamp);
            b.spent = 0;
        }
    }

    function _effectiveSpent(Budget memory b) private view returns (uint192) {
        if (b.epochStartedAt == 0 || block.timestamp >= uint256(b.epochStartedAt) + EPOCH_SECONDS) return 0;
        return b.spent;
    }

    function _effectiveEpochStart(Budget memory b) private view returns (uint64) {
        if (b.epochStartedAt == 0 || block.timestamp >= uint256(b.epochStartedAt) + EPOCH_SECONDS) return uint64(block.timestamp);
        return b.epochStartedAt;
    }
}
