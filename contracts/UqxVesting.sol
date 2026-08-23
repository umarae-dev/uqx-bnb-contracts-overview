// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/// @title UQX Vesting
/// @notice Merkle-proof-based claim contract for UQX mining rewards and
/// presale allocations. A snapshot of every user's off-chain balance
/// (mined in the UQX app, or purchased in the presale) is committed as a
/// single Merkle root at launch. Each user then claims their own share
/// directly, gated by an on-chain, time-based vesting curve that nobody —
/// including the contract owner — can bypass, accelerate, or alter once
/// the root is set.
///
/// Design choices, deliberately:
///  - The owner can set the root exactly once. There is no function to
///    change it afterwards, and no function that moves tokens out of this
///    contract except a user's own claim() call for their own proven
///    allocation. The owner cannot claim on anyone's behalf, freeze a
///    specific address, or redirect anyone's tokens.
///  - 20% of every allocation is liquid immediately at launch (so this
///    isn't a total lockup); the remaining 80% unlocks linearly over the
///    vesting period for that allocation type. This is enforced by plain
///    on-chain arithmetic against block.timestamp, not owner discretion —
///    see vestedAmount().
///  - Mining rewards (earned for free) vest more slowly than presale
///    purchases (paid for with real money), reflecting that the two
///    groups took on different risk.
///
/// Emergency safety valve, and why it's here instead of on the token:
///  - This contract (not UqxToken) carries a pause() switch, restricted to
///    the owner, that stops new claims. UqxToken itself stays permanently
///    free of any owner-controlled function — its balances and transfers
///    can never be frozen by anyone, which is the stronger trust claim to
///    make about the actual asset people hold and trade. This contract is
///    where a real bug is actually plausible to hide (it's new, custom
///    logic — a plain ERC-20 transfer is not), so this is the one place a
///    genuine emergency stop is worth having.
///  - The owner of this contract is intended to be a timelock controller
///    (OpenZeppelin's TimelockController) whose proposer/executor role is
///    held by a multisig, not a single private key — see
///    scripts/uqx/deploy.js. That means every owner action here,
///    including setRoot(), pause(), and unpause(), requires multiple
///    people to agree AND is queued publicly on-chain for a mandatory
///    delay before it takes effect. Nobody, including us, can use this
///    switch instantly or silently.
contract UqxVesting is Ownable, Pausable {
    using SafeERC20 for IERC20;

    enum AllocationType { Mining, Presale }

    IERC20 public immutable token;

    bytes32 public merkleRoot;
    uint256 public launchTimestamp;
    bool public rootSet;

    uint256 public constant IMMEDIATE_BPS = 2_000; // 20.00%, in basis points
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MINING_VESTING_DURATION = 240 days;  // ~8 months
    uint256 public constant PRESALE_VESTING_DURATION = 180 days; // ~6 months

    /// @notice Cumulative amount already withdrawn, keyed by address AND
    /// allocation type separately. A single wallet can plausibly hold both
    /// a mining allocation and a presale allocation — keying this by
    /// address alone would let a claim on one allocation type silently eat
    /// into the claimable balance of the other (a real bug caught in
    /// review, not a hypothetical: the two allocation types even have
    /// different totals and vesting curves, so they must never share one
    /// running total).
    mapping(address => mapping(AllocationType => uint256)) public claimed;

    event RootSet(bytes32 root, uint256 launchTimestamp);
    event Claimed(address indexed account, uint256 amount, AllocationType allocationType);

    constructor(address tokenAddress) {
        require(tokenAddress != address(0), "UqxVesting: token is zero address");
        token = IERC20(tokenAddress);
    }

    /// @notice Owner publishes the TGE snapshot root and the moment
    /// vesting begins. Callable exactly once — irreversible after this.
    /// The root is a deterministic hash of the off-chain mining/presale
    /// ledger, so anyone can independently recompute and verify it.
    function setRoot(bytes32 root, uint256 startTimestamp) external onlyOwner {
        require(!rootSet, "UqxVesting: root already set");
        require(root != bytes32(0), "UqxVesting: root is zero");
        // A startTimestamp of 0, or any past timestamp, would make
        // vestedAmount() treat every allocation as already fully vested the
        // instant the root is set — silently defeating the entire vesting
        // schedule. This can only be called by the owner, so it isn't an
        // attacker-facing exploit, but a single fat-fingered value here
        // (e.g. passing seconds where milliseconds were meant, or 0) would
        // be catastrophic and irreversible, so it's worth guarding on-chain
        // rather than trusting the deploy script to get it right.
        require(startTimestamp >= block.timestamp, "UqxVesting: launch must not be in the past");
        rootSet = true;
        merkleRoot = root;
        launchTimestamp = startTimestamp;
        emit RootSet(root, startTimestamp);
    }

    function vestingDuration(AllocationType allocationType) public pure returns (uint256) {
        return allocationType == AllocationType.Mining ? MINING_VESTING_DURATION : PRESALE_VESTING_DURATION;
    }

    /// @notice Total amount vested so far for a given allocation, regardless
    /// of how much of it has already been claimed.
    function vestedAmount(uint256 totalAmount, AllocationType allocationType) public view returns (uint256) {
        if (!rootSet || block.timestamp < launchTimestamp) return 0;

        uint256 immediate = (totalAmount * IMMEDIATE_BPS) / BPS_DENOMINATOR;
        uint256 remaining = totalAmount - immediate;
        uint256 duration = vestingDuration(allocationType);
        uint256 elapsed = block.timestamp - launchTimestamp;

        if (elapsed >= duration) return totalAmount;
        return immediate + (remaining * elapsed) / duration;
    }

    /// @notice How much is claimable right now for a proven allocation —
    /// vested so far, minus whatever has already been claimed.
    function claimable(address account, uint256 totalAmount, AllocationType allocationType) public view returns (uint256) {
        uint256 vested = vestedAmount(totalAmount, allocationType);
        uint256 already = claimed[account][allocationType];
        return vested > already ? vested - already : 0;
    }

    /// @notice Claim whatever is currently vested for the caller's proven
    /// allocation. Safe to call repeatedly — each call only ever transfers
    /// the newly-vested delta since the last claim.
    function claim(uint256 totalAmount, AllocationType allocationType, bytes32[] calldata merkleProof) external whenNotPaused {
        require(rootSet, "UqxVesting: not launched yet");

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, totalAmount, allocationType))));
        require(MerkleProof.verify(merkleProof, merkleRoot, leaf), "UqxVesting: invalid proof");

        uint256 amount = claimable(msg.sender, totalAmount, allocationType);
        require(amount > 0, "UqxVesting: nothing to claim");

        claimed[msg.sender][allocationType] += amount;
        token.safeTransfer(msg.sender, amount);

        emit Claimed(msg.sender, amount, allocationType);
    }

    /// @notice Emergency stop — halts new claims only. Vesting math keeps
    /// running in the background (vestedAmount() and claimable() still
    /// update normally); nothing anyone has already vested is lost or
    /// altered, it just can't be withdrawn until unpaused. Intended for a
    /// genuine emergency (e.g. a bug discovered in this contract's own
    /// logic), not routine use.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
