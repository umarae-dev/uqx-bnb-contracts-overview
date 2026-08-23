// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/// @title UQX Vesting Reference
/// @notice Public reference implementation of UQX's Merkle-based allocation
/// vesting architecture. It is independently runnable and intentionally omits
/// production governance configuration, snapshot data and operational secrets.
contract UqxVestingReference is Ownable, Pausable {
    using SafeERC20 for IERC20;

    enum AllocationType { Mining, Presale }

    IERC20 public immutable token;
    bytes32 public merkleRoot;
    uint256 public launchTimestamp;
    bool public rootSet;

    uint256 public constant IMMEDIATE_BPS = 2_000;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MINING_VESTING_DURATION = 240 days;
    uint256 public constant PRESALE_VESTING_DURATION = 180 days;

    mapping(address => mapping(AllocationType => uint256)) public claimed;

    event RootSet(bytes32 root, uint256 launchTimestamp);
    event Claimed(address indexed account, uint256 amount, AllocationType allocationType);

    constructor(address tokenAddress) {
        require(tokenAddress != address(0), "UqxVesting: token is zero address");
        token = IERC20(tokenAddress);
    }

    function setRoot(bytes32 root, uint256 startTimestamp) external onlyOwner {
        require(!rootSet, "UqxVesting: root already set");
        require(root != bytes32(0), "UqxVesting: root is zero");
        require(startTimestamp >= block.timestamp, "UqxVesting: launch must not be in the past");
        rootSet = true;
        merkleRoot = root;
        launchTimestamp = startTimestamp;
        emit RootSet(root, startTimestamp);
    }

    function vestingDuration(AllocationType allocationType) public pure returns (uint256) {
        return allocationType == AllocationType.Mining ? MINING_VESTING_DURATION : PRESALE_VESTING_DURATION;
    }

    function vestedAmount(uint256 totalAmount, AllocationType allocationType) public view returns (uint256) {
        if (!rootSet || block.timestamp < launchTimestamp) return 0;
        uint256 immediate = (totalAmount * IMMEDIATE_BPS) / BPS_DENOMINATOR;
        uint256 remaining = totalAmount - immediate;
        uint256 elapsed = block.timestamp - launchTimestamp;
        uint256 duration = vestingDuration(allocationType);
        if (elapsed >= duration) return totalAmount;
        return immediate + (remaining * elapsed) / duration;
    }

    function claimable(address account, uint256 totalAmount, AllocationType allocationType) public view returns (uint256) {
        uint256 vested = vestedAmount(totalAmount, allocationType);
        uint256 already = claimed[account][allocationType];
        return vested > already ? vested - already : 0;
    }

    function claim(uint256 totalAmount, AllocationType allocationType, bytes32[] calldata proof) external whenNotPaused {
        require(rootSet, "UqxVesting: not launched yet");
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, totalAmount, allocationType))));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "UqxVesting: invalid proof");
        uint256 amount = claimable(msg.sender, totalAmount, allocationType);
        require(amount > 0, "UqxVesting: nothing to claim");
        claimed[msg.sender][allocationType] += amount;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount, allocationType);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
