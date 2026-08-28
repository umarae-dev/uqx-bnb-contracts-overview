// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @title SafeCoreAccountV1
/// @notice Experimental, non-upgradeable bounded-loss vault prototype.
/// @dev NOT AUDITED. Do not deploy with production funds until independent review.
///
/// Core invariant targeted by V1:
///   Compromise of the operational owner key alone cannot transfer more than
///   the precommitted per-asset budget during one rolling policy epoch.
///
/// Safety model:
/// - owner: may spend, but only inside existing budgets.
/// - recovery: may initiate owner recovery, but cannot spend.
/// - veto: may cancel delayed security-weakening actions, but cannot spend.
/// - lowering a budget is immediate.
/// - raising a budget is delayed by an immutable minimum delay.
/// - owner rotation through recovery is delayed and vetoable.
/// - no arbitrary call(), delegatecall(), token approvals, upgrade hook, admin
///   withdrawal, or owner bypass exists in V1.
contract SafeCoreAccountV1 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant NATIVE_ASSET = address(0);
    uint64 public constant EPOCH_SECONDS = 1 days;

    address public owner;
    address public recovery;
    address public veto;
    uint64 public immutable minimumSecurityDelay;

    struct Budget {
        uint192 limit;
        uint192 spent;
        uint64 epochStartedAt;
    }

    struct PendingLimitIncrease {
        uint192 newLimit;
        uint64 executableAt;
    }

    struct PendingOwnerRecovery {
        address newOwner;
        uint64 executableAt;
    }

    mapping(address asset => Budget) private _budgets;
    mapping(address asset => PendingLimitIncrease) public pendingLimitIncrease;
    PendingOwnerRecovery public pendingOwnerRecovery;

    event Deposited(address indexed sender, uint256 amount);
    event Spent(address indexed asset, address indexed to, uint256 amount, uint256 remainingInEpoch);
    event BudgetReduced(address indexed asset, uint256 oldLimit, uint256 newLimit);
    event LimitIncreaseRequested(address indexed asset, uint256 oldLimit, uint256 newLimit, uint256 executableAt);
    event LimitIncreaseCancelled(address indexed asset, address indexed cancelledBy);
    event LimitIncreaseApplied(address indexed asset, uint256 oldLimit, uint256 newLimit);
    event OwnerRecoveryRequested(address indexed oldOwner, address indexed newOwner, uint256 executableAt);
    event OwnerRecoveryCancelled(address indexed newOwner, address indexed cancelledBy);
    event OwnerRecovered(address indexed oldOwner, address indexed newOwner);

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error BudgetExceeded();
    error BudgetNotReduced();
    error IncreaseNotRequested();
    error IncreaseNotReady();
    error RecoveryNotRequested();
    error RecoveryNotReady();
    error NativeTransferFailed();
    error AmountTooLarge();
    error InvalidDelay();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyRecovery() {
        if (msg.sender != recovery) revert Unauthorized();
        _;
    }

    modifier onlySafetyAuthority() {
        if (msg.sender != owner && msg.sender != recovery && msg.sender != veto) revert Unauthorized();
        _;
    }

    constructor(
        address initialOwner,
        address recoveryKey,
        address vetoKey,
        uint64 minSecurityDelay,
        address[] memory initialAssets,
        uint192[] memory initialLimits
    ) {
        if (initialOwner == address(0) || recoveryKey == address(0) || vetoKey == address(0)) revert ZeroAddress();
        if (minSecurityDelay < 1 hours || minSecurityDelay > 30 days) revert InvalidDelay();
        if (initialAssets.length != initialLimits.length) revert AmountTooLarge();

        owner = initialOwner;
        recovery = recoveryKey;
        veto = vetoKey;
        minimumSecurityDelay = minSecurityDelay;

        uint64 nowTs = uint64(block.timestamp);
        for (uint256 i = 0; i < initialAssets.length; ++i) {
            _budgets[initialAssets[i]] = Budget({
                limit: initialLimits[i],
                spent: 0,
                epochStartedAt: nowTs
            });
        }
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function budgetOf(address asset) external view returns (uint256 limit, uint256 spent, uint256 remaining, uint256 epochStartedAt) {
        Budget memory b = _budgets[asset];
        uint192 effectiveSpent = _effectiveSpent(b);
        limit = b.limit;
        spent = effectiveSpent;
        remaining = b.limit > effectiveSpent ? uint256(b.limit - effectiveSpent) : 0;
        epochStartedAt = _effectiveEpochStart(b);
    }

    function spendNative(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _consumeBudget(NATIVE_ASSET, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit Spent(NATIVE_ASSET, to, amount, _remaining(NATIVE_ASSET));
    }

    function spendToken(IERC20 token, address to, uint256 amount) external onlyOwner nonReentrant {
        address asset = address(token);
        if (asset == address(0) || to == address(0)) revert ZeroAddress();
        _consumeBudget(asset, amount);
        token.safeTransfer(to, amount);
        emit Spent(asset, to, amount, _remaining(asset));
    }

    function reduceBudgetImmediately(address asset, uint192 newLimit) external onlyOwner {
        _rollEpoch(asset);
        Budget storage b = _budgets[asset];
        if (newLimit >= b.limit) revert BudgetNotReduced();
        uint192 old = b.limit;
        b.limit = newLimit;
        delete pendingLimitIncrease[asset];
        emit BudgetReduced(asset, old, newLimit);
    }

    function requestBudgetIncrease(address asset, uint192 newLimit) external onlyOwner {
        _rollEpoch(asset);
        Budget storage b = _budgets[asset];
        if (newLimit <= b.limit) revert BudgetNotReduced();
        uint64 executableAt = uint64(block.timestamp) + minimumSecurityDelay;
        pendingLimitIncrease[asset] = PendingLimitIncrease(newLimit, executableAt);
        emit LimitIncreaseRequested(asset, b.limit, newLimit, executableAt);
    }

    function cancelBudgetIncrease(address asset) external onlySafetyAuthority {
        PendingLimitIncrease memory pending = pendingLimitIncrease[asset];
        if (pending.executableAt == 0) revert IncreaseNotRequested();
        delete pendingLimitIncrease[asset];
        emit LimitIncreaseCancelled(asset, msg.sender);
    }

    function applyBudgetIncrease(address asset) external {
        PendingLimitIncrease memory pending = pendingLimitIncrease[asset];
        if (pending.executableAt == 0) revert IncreaseNotRequested();
        if (block.timestamp < pending.executableAt) revert IncreaseNotReady();

        _rollEpoch(asset);
        Budget storage b = _budgets[asset];
        uint192 old = b.limit;
        if (pending.newLimit <= old) revert BudgetNotReduced();
        b.limit = pending.newLimit;
        delete pendingLimitIncrease[asset];
        emit LimitIncreaseApplied(asset, old, pending.newLimit);
    }

    function requestOwnerRecovery(address newOwner) external onlyRecovery {
        if (newOwner == address(0) || newOwner == owner) revert ZeroAddress();
        uint64 executableAt = uint64(block.timestamp) + minimumSecurityDelay;
        pendingOwnerRecovery = PendingOwnerRecovery(newOwner, executableAt);
        emit OwnerRecoveryRequested(owner, newOwner, executableAt);
    }

    function cancelOwnerRecovery() external {
        if (msg.sender != owner && msg.sender != veto) revert Unauthorized();
        PendingOwnerRecovery memory pending = pendingOwnerRecovery;
        if (pending.executableAt == 0) revert RecoveryNotRequested();
        delete pendingOwnerRecovery;
        emit OwnerRecoveryCancelled(pending.newOwner, msg.sender);
    }

    function applyOwnerRecovery() external {
        PendingOwnerRecovery memory pending = pendingOwnerRecovery;
        if (pending.executableAt == 0) revert RecoveryNotRequested();
        if (block.timestamp < pending.executableAt) revert RecoveryNotReady();
        address old = owner;
        owner = pending.newOwner;
        delete pendingOwnerRecovery;
        emit OwnerRecovered(old, owner);
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
