// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title SafeCoreDeviceAccountV2
/// @notice EXPERIMENTAL three-factor device-authorized bounded-loss vault.
/// @dev NOT AUDITED. DO NOT DEPLOY WITH PRODUCTION FUNDS.
///
/// Security model:
/// 1. `identity` is the standard seed/private-key-derived EVM identity. It can
///    request security changes but it CANNOT spend vault funds.
/// 2. `recoverySigner` is a separate offline signer. Only its public address is
///    stored on-chain. Its private key/code must never be submitted in calldata.
/// 3. an already-authorized `device` must approve normal new-device enrollment.
///
/// A stolen mnemonic/private key alone therefore cannot spend from this vault
/// and cannot authorize a new spending device. Spending is additionally bounded
/// by per-asset epoch limits. Emergency enrollment intentionally drops the old
/// device factor only after a longer vetoable delay and still requires both the
/// identity transaction and a valid offline recovery signature.
contract SafeCoreDeviceAccountV2 is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    address public constant NATIVE_ASSET = address(0);
    uint64 public constant EPOCH_SECONDS = 1 days;

    bytes32 private constant ENROLL_TYPEHASH = keccak256(
        "EnrollDevice(address account,address newDevice,uint256 nonce,uint256 deadline,bool emergency)"
    );
    bytes32 private constant REVOKE_TYPEHASH = keccak256(
        "RevokeDevice(address account,address device,uint256 nonce,uint256 deadline)"
    );

    address public immutable identity;
    address public immutable recoverySigner;
    address public immutable veto;
    uint64 public immutable enrollmentDelay;
    uint64 public immutable emergencyDelay;

    mapping(address device => bool) public authorizedDevice;
    uint256 public authorizedDeviceCount;
    uint256 public securityNonce;

    struct Budget {
        uint192 limit;
        uint192 spent;
        uint64 epochStartedAt;
    }

    struct PendingEnrollment {
        uint64 executableAt;
        bool existingDeviceApproved;
        bool emergency;
        address approvedBy;
    }

    mapping(address asset => Budget) private _budgets;
    mapping(address device => PendingEnrollment) public pendingEnrollment;

    event Deposited(address indexed sender, uint256 amount);
    event Spent(address indexed device, address indexed asset, address indexed to, uint256 amount, uint256 remainingInEpoch);
    event DeviceEnrollmentRequested(address indexed newDevice, bool emergency, uint256 executableAt, uint256 nonce);
    event DeviceEnrollmentApproved(address indexed newDevice, address indexed approvedBy);
    event DeviceEnrollmentCancelled(address indexed newDevice, address indexed cancelledBy);
    event DeviceActivated(address indexed newDevice);
    event DeviceRevoked(address indexed device);
    event BudgetReduced(address indexed asset, uint256 oldLimit, uint256 newLimit);

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidDelay();
    error InvalidSignature();
    error SignatureExpired();
    error AlreadyAuthorized();
    error NotAuthorized();
    error EnrollmentMissing();
    error EnrollmentNotReady();
    error ExistingDeviceApprovalMissing();
    error LastDevice();
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

    modifier onlyVetoOrDevice() {
        if (msg.sender != veto && !authorizedDevice[msg.sender]) revert Unauthorized();
        _;
    }

    constructor(
        address identity_,
        address recoverySigner_,
        address veto_,
        address initialDevice,
        uint64 enrollmentDelay_,
        uint64 emergencyDelay_,
        address[] memory initialAssets,
        uint192[] memory initialLimits
    ) EIP712("SafeCoreDeviceAccountV2", "1") {
        if (identity_ == address(0) || recoverySigner_ == address(0) || veto_ == address(0) || initialDevice == address(0)) {
            revert ZeroAddress();
        }
        if (enrollmentDelay_ < 1 hours || enrollmentDelay_ > 7 days) revert InvalidDelay();
        if (emergencyDelay_ < enrollmentDelay_ + 1 days || emergencyDelay_ > 30 days) revert InvalidDelay();
        if (initialAssets.length != initialLimits.length) revert AmountTooLarge();

        identity = identity_;
        recoverySigner = recoverySigner_;
        veto = veto_;
        enrollmentDelay = enrollmentDelay_;
        emergencyDelay = emergencyDelay_;

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

    /// @notice Standard enrollment requires identity + offline recovery signature
    /// + approval by an existing authorized device + delay.
    function requestDeviceEnrollment(
        address newDevice,
        uint256 deadline,
        bytes calldata recoverySignature
    ) external onlyIdentity {
        _requestEnrollment(newDevice, deadline, recoverySignature, false);
    }

    /// @notice Lost-device recovery drops existing-device approval only after a
    /// longer vetoable delay. It still requires identity + recovery signature.
    function requestEmergencyDeviceEnrollment(
        address newDevice,
        uint256 deadline,
        bytes calldata recoverySignature
    ) external onlyIdentity {
        _requestEnrollment(newDevice, deadline, recoverySignature, true);
    }

    function approveDeviceEnrollment(address newDevice) external onlyDevice {
        PendingEnrollment storage p = pendingEnrollment[newDevice];
        if (p.executableAt == 0) revert EnrollmentMissing();
        if (p.emergency) revert ExistingDeviceApprovalMissing();
        p.existingDeviceApproved = true;
        p.approvedBy = msg.sender;
        emit DeviceEnrollmentApproved(newDevice, msg.sender);
    }

    function cancelDeviceEnrollment(address newDevice) external onlyVetoOrDevice {
        if (pendingEnrollment[newDevice].executableAt == 0) revert EnrollmentMissing();
        delete pendingEnrollment[newDevice];
        emit DeviceEnrollmentCancelled(newDevice, msg.sender);
    }

    function activateDevice(address newDevice) external {
        PendingEnrollment memory p = pendingEnrollment[newDevice];
        if (p.executableAt == 0) revert EnrollmentMissing();
        if (block.timestamp < p.executableAt) revert EnrollmentNotReady();
        if (!p.emergency && !p.existingDeviceApproved) revert ExistingDeviceApprovalMissing();
        if (authorizedDevice[newDevice]) revert AlreadyAuthorized();

        authorizedDevice[newDevice] = true;
        authorizedDeviceCount += 1;
        delete pendingEnrollment[newDevice];
        emit DeviceActivated(newDevice);
    }

    /// @notice Revocation is a security-tightening action. Identity + offline
    /// recovery signer can revoke immediately. This prevents one compromised
    /// device from arbitrarily removing other trusted devices.
    function revokeDevice(
        address device,
        uint256 deadline,
        bytes calldata recoverySignature
    ) external onlyIdentity {
        if (!authorizedDevice[device]) revert NotAuthorized();
        if (authorizedDeviceCount <= 1) revert LastDevice();
        _checkDeadline(deadline);
        uint256 nonce = securityNonce++;
        bytes32 structHash = keccak256(abi.encode(REVOKE_TYPEHASH, address(this), device, nonce, deadline));
        _verifyRecovery(structHash, recoverySignature);

        authorizedDevice[device] = false;
        authorizedDeviceCount -= 1;
        delete pendingEnrollment[device];
        emit DeviceRevoked(device);
    }

    function budgetOf(address asset) external view returns (uint256 limit, uint256 spent, uint256 remaining, uint256 epochStartedAt) {
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

    /// @notice Tightening is immediate and may be done by any authorized device.
    function reduceBudgetImmediately(address asset, uint192 newLimit) external onlyDevice {
        _rollEpoch(asset);
        Budget storage b = _budgets[asset];
        if (newLimit >= b.limit) revert BudgetNotReduced();
        uint192 old = b.limit;
        b.limit = newLimit;
        emit BudgetReduced(asset, old, newLimit);
    }

    function enrollmentDigest(
        address newDevice,
        uint256 nonce,
        uint256 deadline,
        bool emergency
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(ENROLL_TYPEHASH, address(this), newDevice, nonce, deadline, emergency))
        );
    }

    function revokeDigest(address device, uint256 nonce, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REVOKE_TYPEHASH, address(this), device, nonce, deadline)));
    }

    function _requestEnrollment(
        address newDevice,
        uint256 deadline,
        bytes calldata recoverySignature,
        bool emergency
    ) private {
        if (newDevice == address(0)) revert ZeroAddress();
        if (authorizedDevice[newDevice]) revert AlreadyAuthorized();
        _checkDeadline(deadline);

        uint256 nonce = securityNonce++;
        bytes32 structHash = keccak256(
            abi.encode(ENROLL_TYPEHASH, address(this), newDevice, nonce, deadline, emergency)
        );
        _verifyRecovery(structHash, recoverySignature);

        uint64 executableAt = uint64(block.timestamp) + (emergency ? emergencyDelay : enrollmentDelay);
        pendingEnrollment[newDevice] = PendingEnrollment({
            executableAt: executableAt,
            existingDeviceApproved: false,
            emergency: emergency,
            approvedBy: address(0)
        });
        emit DeviceEnrollmentRequested(newDevice, emergency, executableAt, nonce);
    }

    function _verifyRecovery(bytes32 structHash, bytes calldata signature) private view {
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = digest.recover(signature);
        if (recovered != recoverySigner) revert InvalidSignature();
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
