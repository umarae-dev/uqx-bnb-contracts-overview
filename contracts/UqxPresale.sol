// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/// @title UQX Presale
/// @notice Sells UQX directly to buyer wallets at a fixed USD price, paid in
/// USDT or USDC (both 18 decimals on BNB Smart Chain — verified on-chain
/// before writing this, since Ethereum's USDT is 6 decimals and getting
/// that wrong here would silently misprice every single purchase).
contract UqxPresale is Ownable, Pausable {
    using SafeERC20 for IERC20;

    IERC20 public immutable uqx;
    address public fundsRecipient;

    uint256 public constant PRICE_PER_TOKEN_USD = 5 * 10 ** 15;
    uint256 public constant PRESALE_CAP = 150_000_000 * 10 ** 18;
    uint256 public constant IMMEDIATE_BPS = 2_000;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant VESTING_DURATION = 180 days;

    mapping(address => bool) public acceptedPaymentToken;

    struct Buyer {
        uint256 totalPurchased;
        uint256 claimed;
        uint256 firstPurchaseAt;
    }

    mapping(address => Buyer) public buyers;
    uint256 public totalSold;

    event PaymentTokenSet(address indexed token, bool accepted);
    event Purchased(address indexed buyer, address indexed paymentToken, uint256 paidAmount, uint256 uqxAmount);
    event Claimed(address indexed buyer, uint256 amount);
    event UnsoldWithdrawn(address indexed to, uint256 amount);

    constructor(address uqxToken, address fundsRecipient_) {
        require(uqxToken != address(0), "UqxPresale: token is zero address");
        require(fundsRecipient_ != address(0), "UqxPresale: fundsRecipient is zero address");
        uqx = IERC20(uqxToken);
        fundsRecipient = fundsRecipient_;
    }

    function setAcceptedPaymentToken(address token, bool accepted) external onlyOwner {
        require(token != address(0), "UqxPresale: token is zero address");
        acceptedPaymentToken[token] = accepted;
        emit PaymentTokenSet(token, accepted);
    }

    function quote(uint256 paymentAmount) public pure returns (uint256 uqxAmount) {
        return (paymentAmount * 10 ** 18) / PRICE_PER_TOKEN_USD;
    }

    function buy(address paymentToken, uint256 paymentAmount) external whenNotPaused {
        require(acceptedPaymentToken[paymentToken], "UqxPresale: payment token not accepted");
        require(paymentAmount > 0, "UqxPresale: zero amount");

        uint256 uqxAmount = quote(paymentAmount);
        require(totalSold + uqxAmount <= PRESALE_CAP, "UqxPresale: exceeds presale cap");

        Buyer storage b = buyers[msg.sender];
        if (b.firstPurchaseAt == 0) {
            b.firstPurchaseAt = block.timestamp;
        }
        b.totalPurchased += uqxAmount;
        totalSold += uqxAmount;

        IERC20(paymentToken).safeTransferFrom(msg.sender, fundsRecipient, paymentAmount);

        emit Purchased(msg.sender, paymentToken, paymentAmount, uqxAmount);
    }

    function vestedAmount(address buyer) public view returns (uint256) {
        Buyer storage b = buyers[buyer];
        if (b.firstPurchaseAt == 0 || block.timestamp < b.firstPurchaseAt) return 0;

        uint256 immediate = (b.totalPurchased * IMMEDIATE_BPS) / BPS_DENOMINATOR;
        uint256 remaining = b.totalPurchased - immediate;
        uint256 elapsed = block.timestamp - b.firstPurchaseAt;

        if (elapsed >= VESTING_DURATION) return b.totalPurchased;
        return immediate + (remaining * elapsed) / VESTING_DURATION;
    }

    function claimable(address buyer) public view returns (uint256) {
        uint256 vested = vestedAmount(buyer);
        uint256 already = buyers[buyer].claimed;
        return vested > already ? vested - already : 0;
    }

    function claim() external whenNotPaused {
        uint256 amount = claimable(msg.sender);
        require(amount > 0, "UqxPresale: nothing to claim");

        buyers[msg.sender].claimed += amount;
        uqx.safeTransfer(msg.sender, amount);

        emit Claimed(msg.sender, amount);
    }

    function withdrawUnsold(address to) external onlyOwner {
        require(to != address(0), "UqxPresale: zero address");
        uint256 reserved = totalSold;
        uint256 balance = uqx.balanceOf(address(this));
        require(balance > reserved, "UqxPresale: nothing unsold to withdraw");
        uint256 unsold = balance - reserved;
        uqx.safeTransfer(to, unsold);
        emit UnsoldWithdrawn(to, unsold);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
