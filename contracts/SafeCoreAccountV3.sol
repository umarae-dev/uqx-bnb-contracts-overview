// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title SafeCoreAccountV3
/// @notice EXPERIMENTAL device-authorized self-custody vault with a one-time
///         paper recovery secret and exactly two pre-registered rescue addresses.
/// @dev NOT AUDITED. DO NOT DEPLOY WITH PRODUCTION FUNDS.
///
/// Core security invariants:
/// - The standard seed/private-key-derived `identity` CANNOT spend protected funds.
/// - Normal spending requires an authorized device key.
/// - A new device must prove possession of its own key and then be approved by
///   an already-authorized device. Approval can be submitted directly or as an
///   offline EIP-712 signature bound to the exact pairing hash.
/// - Lost-device recovery NEVER grants a new device arbitrary spending power.
///   It only evacuates funds to emergencyAddress1 or emergencyAddress2.
/// - The paper recovery secret is stored only as a hash commitment and is burned
///   before the first emergency transfer. It cannot be replayed.
/// - Emergency destination changes are delayed; tightening/revocation remains fast.
///
/// V3 intentionally remains transfer-only. Arbitrary calls, approvals, delegatecall,
/// swaps and dApp execution are NOT part of this prototype and must be introduced
/// later behind a separately audited policy/module layer.
contract SafeCoreAccountV3 is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    address public constant NATIVE_ASSET = address(0);
    uint64 public constant EPOCH_SECONDS = 1 days;
    uint256 public constant MAX_EMERGENCY_RESCUE_ITEMS = 32;

    bytes32 private constant PAIR_TYPEHASH = keccak256(
        "PairDevice(address account,address newDevice,bytes32 pairingHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant APPROVE_TYPEHASH = keccak256(
        "ApproveDevice(address account,address newDevice,bytes32 pairingHash,uint256 enrollmentNonce,uint256 deadline)"
    );

    address public immutable identity;
    uint64 public immutable emergencyDestinationChangeDelay;

    mapping(address device => bool) public authorizedDevice;
    uint256 public authorizedDeviceCount;
    uint256 public securityNonce;

    address public emergencyAddress1;
    address public emergencyAddress2;
    bytes32 public recoveryCommitment;
    uint256 public recoveryGeneration;

    struct Budget {
        uint192 limit;
        uint192 spent;
        uint64 epochStartedAt;
    }

    struct PendingEnrollment {
        bytes32 pairingHash;
        uint256 enrollmentNonce;
        uint64 requestedAt;
    }

    struct PendingEmergencyDestinations {
        address first;
        address second;
        uint64 executableAt;
        address requestedBy;
    }

    mapping(address asset => Budget) private _budgets;
    mapping(address device => PendingEnrollment) public pendingEnrollment;
    PendingEmergencyDestinations public pendingEmergencyDestinations;

    event Deposited(address indexed sender, uint256 amount);
    event Spent(address indexed device, address indexed asset, address indexed to, uint256 amount, uint256 remainingInEpoch);

    event DeviceEnrollmentRequested(
        address indexed newDevice,
        bytes32 indexed pairingHash,
        uint256 indexed enrollmentNonce,
        uint256 deadline
    );
    event DeviceEnrollmentCancelled(address indexed newDevice, address indexed cancelledBy);
    event DeviceActivated(address indexed newDevice, address indexed approvedBy, bytes32 indexed pairingHash);
    event DeviceRevoked(address indexed device, address indexed revokedBy);

    event RecoveryCommitmentArmed(bytes32 indexed commitment, uint256 indexed generation, address indexed armedBy);
    event EmergencyRescueExecuted(
        uint256 indexed generation,
        address indexed asset,
        address indexed destination,
        uint256 amount
    );
    event EmergencyRecoveryConsumed(uint256 indexed generation);

    event EmergencyDestinationsChangeRequested(
        address indexed first,
        address indexed second,
        uint256 executableAt,
        address requestedBy
    );
    event EmergencyDestinationsChangeCancelled(address indexed cancelledBy);
    event EmergencyDestinationsChanged(address indexed first, address indexed second);

    event BudgetReduced(address indexed asset, uint256 oldLimit, uint256 newLimit);

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidDelay();
    error InvalidSignature();
    error SignatureExpired();
    error AlreadyAuthorized();
    error NotAuthorized();
    error LastDevice();
    error EnrollmentExists();
    error EnrollmentMissing();
    error PairingHashMismatch();
    error InvalidPairingHash();
    error RecoveryNotArmed();
    error InvalidRecoverySecret();
    error EmergencyDestinationOnly();
    error InvalidEmergencyDestinations();
    error DestinationChangeMissing();
    error DestinationChangeNotReady();
    error ArrayLengthMismatch();
    error TooManyItems();
    error InsufficientBalance();
    error BudgetExceeded();
    error BudgetNotReduced();
    error AmountTooLarge();
    error NativeTransferFailed();

    modifier onlyIdentity() {
        if (msg.sender != identity) revert Unauthorized();
        _;
    }

    modifier onlyDevice() {
        if (!authorizedDevice[msg.sender]) revert Unauthorized();
        _;
    }

    constructor(
        address identity_,
        address initialDevice,
        address emergencyAddress1_,
        address emergencyAddress2_,
        bytes32 recoveryCommitment_,
        uint64 emergencyDestinationChangeDelay_,
        address[] memory initialAssets,
        uint192[] memory initialLimits
    ) EIP712("SafeCoreAccountV3", "1") {
        if (identity_ == address(0) || initialDevice == address(0)) revert ZeroAddress();
        _validateEmergencyDestinations(emergencyAddress1_, emergencyAddress2_);
        if (recoveryCommitment_ == bytes32(0)) revert RecoveryNotArmed();
        if (emergencyDestinationChangeDelay_ < 1 days || emergencyDestinationChangeDelay_ > 30 days) {
            revert InvalidDelay();
        }
        if (initialAssets.length != initialLimits.length) revert AmountTooLarge();

        identity = identity_;
        emergencyDestinationChangeDelay = emergencyDestinationChangeDelay_;
        emergencyAddress1 = emergencyAddress1_;
        emergencyAddress2 = emergencyAddress2_;
        recoveryCommitment = recoveryCommitment_;
        recoveryGeneration = 1;

        authorizedDevice[initialDevice] = true;
        authorizedDeviceCount = 1;

        uint64 nowTs = uint64(block.timestamp);
        for (uint256 i = 0; i < initialAssets.length; ++i) {
            _budgets[initialAssets[i]] = Budget({limit: initialLimits[i], spent: 0, epochStartedAt: nowTs});
        }
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------------
    // Normal device authorization
    // ---------------------------------------------------------------------

    /// @notice Starts pairing from the seed-derived identity, while requiring
    /// the NEW device to cryptographically prove that it controls `newDevice`.
    /// This request alone never authorizes spending.
    function requestDeviceEnrollment(
        address newDevice,
        bytes32 pairingHash,
        uint256 deadline,
        bytes calldata newDeviceSignature
    ) external onlyIdentity {
        if (newDevice == address(0)) revert ZeroAddress();
        if (authorizedDevice[newDevice]) revert AlreadyAuthorized();
        if (pendingEnrollment[newDevice].requestedAt != 0) revert EnrollmentExists();
        if (pairingHash == bytes32(0)) revert InvalidPairingHash();
        _checkDeadline(deadline);

        uint256 nonce = securityNonce++;
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(PAIR_TYPEHASH, address(this), newDevice, pairingHash, nonce, deadline))
        );
        if (digest.recover(newDeviceSignature) != newDevice) revert InvalidSignature();

        pendingEnrollment[newDevice] = PendingEnrollment({
            pairingHash: pairingHash,
            enrollmentNonce: nonce,
            requestedAt: uint64(block.timestamp)
        });

        emit DeviceEnrollmentRequested(newDevice, pairingHash, nonce, deadline);
    }

    /// @notice Online approval path. Existing trusted device approves the exact
    /// new-device public key + pairing hash and activates it immediately.
    function approveAndActivateDevice(address newDevice, bytes32 pairingHash) external onlyDevice {
        PendingEnrollment memory pending = _checkedPendingEnrollment(newDevice, pairingHash);
        _activateDevice(newDevice, msg.sender, pending.pairingHash);
    }

    /// @notice Offline/nearby approval path. The old device can sign this EIP-712
    /// approval while paired over QR/NFC/BLE; the signature may be relayed later.
    function activateDeviceWithApprovalSignature(
        address newDevice,
        bytes32 pairingHash,
        address approvingDevice,
        uint256 deadline,
        bytes calldata approvalSignature
    ) external {
        PendingEnrollment memory pending = _checkedPendingEnrollment(newDevice, pairingHash);
        if (!authorizedDevice[approvingDevice]) revert NotAuthorized();
        _checkDeadline(deadline);

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    APPROVE_TYPEHASH,
                    address(this),
                    newDevice,
                    pairingHash,
                    pending.enrollmentNonce,
                    deadline
                )
            )
        );
        if (digest.recover(approvalSignature) != approvingDevice) revert InvalidSignature();

        _activateDevice(newDevice, approvingDevice, pending.pairingHash);
    }

    function cancelDeviceEnrollment(address newDevice) external onlyDevice {
        if (pendingEnrollment[newDevice].requestedAt == 0) revert EnrollmentMissing();
        delete pendingEnrollment[newDevice];
        emit DeviceEnrollmentCancelled(newDevice, msg.sender);
    }

    /// @notice Once a second device is genuinely authorized, either trusted
    /// device may revoke another device immediately. The last device cannot be removed.
    function revokeDevice(address device) external onlyDevice {
        if (!authorizedDevice[device]) revert NotAuthorized();
        if (authorizedDeviceCount <= 1) revert LastDevice();

        authorizedDevice[device] = false;
        authorizedDeviceCount -= 1;
        delete pendingEnrollment[device];
        emit DeviceRevoked(device, msg.sender);
    }

    // ---------------------------------------------------------------------
    // One-time paper recovery + two-destination emergency rescue
    // ---------------------------------------------------------------------

    /// @notice Arms a fresh one-time paper recovery secret by storing ONLY its
    /// hash. The raw paper secret must never be stored by the app/server.
    /// An already-authorized device may re-arm after a prior recovery was consumed.
    function armRecoveryCommitment(bytes32 newCommitment) external onlyDevice {
        if (newCommitment == bytes32(0)) revert RecoveryNotArmed();
        recoveryCommitment = newCommitment;
        recoveryGeneration += 1;
        emit RecoveryCommitmentArmed(newCommitment, recoveryGeneration, msg.sender);
    }

    /// @notice Lost-device escape hatch. Requires BOTH the seed-derived identity
    /// and the one-time paper secret. The secret is burned before any external
    /// transfer. Every destination MUST already be one of the two registered
    /// emergency addresses; arbitrary addresses are impossible in this path.
    ///
    /// Use amount == type(uint256).max to rescue the full current balance of an
    /// asset. `asset == address(0)` represents native BNB.
    function emergencyRescue(
        bytes32 paperSecret,
        address[] calldata assets,
        uint256[] calldata amounts,
        address[] calldata destinations
    ) external onlyIdentity nonReentrant {
        uint256 length = assets.length;
        if (length == 0 || length != amounts.length || length != destinations.length) {
            revert ArrayLengthMismatch();
        }
        if (length > MAX_EMERGENCY_RESCUE_ITEMS) revert TooManyItems();

        bytes32 armed = recoveryCommitment;
        if (armed == bytes32(0)) revert RecoveryNotArmed();
        if (keccak256(abi.encodePacked(paperSecret)) != armed) revert InvalidRecoverySecret();

        // Validate the ENTIRE rescue before consuming the one-time secret.
        for (uint256 i = 0; i < length; ++i) {
            if (!_isEmergencyDestination(destinations[i])) revert EmergencyDestinationOnly();
            if (amounts[i] == 0) revert ZeroAmount();
        }

        uint256 generation = recoveryGeneration;

        // Checks-effects-interactions: burn first. Any later revert atomically
        // restores the commitment, but reentrancy cannot reuse it mid-execution.
        recoveryCommitment = bytes32(0);
        emit EmergencyRecoveryConsumed(generation);

        for (uint256 i = 0; i < length; ++i) {
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

            emit EmergencyRescueExecuted(generation, asset, to, amount);
        }
    }

    function recoveryCommitmentFor(bytes32 paperSecret) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(paperSecret));
    }

    // ---------------------------------------------------------------------
    // Emergency destination management
    // ---------------------------------------------------------------------

    /// @notice Changing the two rescue destinations is intentionally delayed.
    /// A stolen phrase cannot call this; only an already-authorized device can.
    function requestEmergencyDestinationsChange(address first, address second) external onlyDevice {
        _validateEmergencyDestinations(first, second);
        uint64 executableAt = uint64(block.timestamp) + emergencyDestinationChangeDelay;
        pendingEmergencyDestinations = PendingEmergencyDestinations({
            first: first,
            second: second,
            executableAt: executableAt,
            requestedBy: msg.sender
        });
        emit EmergencyDestinationsChangeRequested(first, second, executableAt, msg.sender);
    }

    function cancelEmergencyDestinationsChange() external onlyDevice {
        if (pendingEmergencyDestinations.executableAt == 0) revert DestinationChangeMissing();
        delete pendingEmergencyDestinations;
        emit EmergencyDestinationsChangeCancelled(msg.sender);
    }

    function applyEmergencyDestinationsChange() external {
        PendingEmergencyDestinations memory pending = pendingEmergencyDestinations;
        if (pending.executableAt == 0) revert DestinationChangeMissing();
        if (block.timestamp < pending.executableAt) revert DestinationChangeNotReady();

        emergencyAddress1 = pending.first;
        emergencyAddress2 = pending.second;
        delete pendingEmergencyDestinations;
        emit EmergencyDestinationsChanged(emergencyAddress1, emergencyAddress2);
    }

    function isEmergencyDestination(address candidate) external view returns (bool) {
        return _isEmergencyDestination(candidate);
    }

    // ---------------------------------------------------------------------
    // Bounded normal spending
    // ---------------------------------------------------------------------

    function budgetOf(address asset)
        external
        view
        returns (uint256 limit, uint256 spent, uint256 remaining, uint256 epochStartedAt)
    {
        Budget memory b = _budgets[asset];
        uint192 effectiveSpent = _effectiveSpent(b);
        limit = b.limit;
        spent = effectiveSpent;
        remaining = b.limit > effectiveSpent ? uint256(b.limit - effectiveSpent) : 0;
        epochStartedAt = _effectiveEpochStart(b);
    }

    function spendNative(address payable to, uint256 amount) external onlyDevice nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _consumeBudget(NATIVE_ASSET, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit Spent(msg.sender, NATIVE_ASSET, to, amount, _remaining(NATIVE_ASSET));
    }

    function spendToken(IERC20 token, address to, uint256 amount) external onlyDevice nonReentrant {
        address asset = address(token);
        if (asset == address(0) || to == address(0)) revert ZeroAddress();
        _consumeBudget(asset, amount);
        token.safeTransfer(to, amount);
        emit Spent(msg.sender, asset, to, amount, _remaining(asset));
    }

    /// @notice Security tightening remains immediate.
    function reduceBudgetImmediately(address asset, uint192 newLimit) external onlyDevice {
        _rollEpoch(asset);
        Budget storage b = _budgets[asset];
        if (newLimit >= b.limit) revert BudgetNotReduced();
        uint192 old = b.limit;
        b.limit = newLimit;
        emit BudgetReduced(asset, old, newLimit);
    }

    // ---------------------------------------------------------------------
    // Typed-data helpers for mobile clients / offline pairing
    // ---------------------------------------------------------------------

    function pairingDigest(
        address newDevice,
        bytes32 pairingHash,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(PAIR_TYPEHASH, address(this), newDevice, pairingHash, nonce, deadline))
        );
    }

    function approvalDigest(
        address newDevice,
        bytes32 pairingHash,
        uint256 enrollmentNonce,
        uint256 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    APPROVE_TYPEHASH,
                    address(this),
                    newDevice,
                    pairingHash,
                    enrollmentNonce,
                    deadline
                )
            )
        );
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _checkedPendingEnrollment(address newDevice, bytes32 pairingHash)
        private
        view
        returns (PendingEnrollment memory pending)
    {
        pending = pendingEnrollment[newDevice];
        if (pending.requestedAt == 0) revert EnrollmentMissing();
        if (pending.pairingHash != pairingHash) revert PairingHashMismatch();
        if (authorizedDevice[newDevice]) revert AlreadyAuthorized();
    }

    function _activateDevice(address newDevice, address approvedBy, bytes32 pairingHash) private {
        authorizedDevice[newDevice] = true;
        authorizedDeviceCount += 1;
        delete pendingEnrollment[newDevice];
        emit DeviceActivated(newDevice, approvedBy, pairingHash);
    }

    function _validateEmergencyDestinations(address first, address second) private view {
        if (first == address(0) || second == address(0)) revert InvalidEmergencyDestinations();
        if (first == second) revert InvalidEmergencyDestinations();
        if (first == address(this) || second == address(this)) revert InvalidEmergencyDestinations();
    }

    function _isEmergencyDestination(address candidate) private view returns (bool) {
        return candidate == emergencyAddress1 || candidate == emergencyAddress2;
    }

    function _checkDeadline(uint256 deadline) private view {
        if (deadline < block.timestamp) revert SignatureExpired();
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
            return;
        }
        if (block.timestamp >= uint256(b.epochStartedAt) + EPOCH_SECONDS) {
            b.epochStartedAt = uint64(block.timestamp);
            b.spent = 0;
        }
    }

    function _effectiveSpent(Budget memory b) private view returns (uint192) {
        if (b.epochStartedAt == 0 || block.timestamp >= uint256(b.epochStartedAt) + EPOCH_SECONDS) return 0;
        return b.spent;
    }

    function _effectiveEpochStart(Budget memory b) private view returns (uint64) {
        if (b.epochStartedAt == 0 || block.timestamp >= uint256(b.epochStartedAt) + EPOCH_SECONDS) {
            return uint64(block.timestamp);
        }
        return b.epochStartedAt;
    }

    function _remaining(address asset) private view returns (uint256) {
        Budget memory b = _budgets[asset];
        uint192 spent = _effectiveSpent(b);
        return b.limit > spent ? uint256(b.limit - spent) : 0;
    }
}
