// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/// @title UQX Presale Reference
/// @notice Public reference implementation of UQX fixed-price token allocation
/// and linear vesting. It intentionally excludes production recipient addresses,
/// payment-token allowlists, governance configuration and deployment secrets.
contract UqxPresaleReference is Ownable, Pausable {
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

        Buyer storage buyer = buyers[msg.sender];
        if (buyer.firstPurchaseAt == 0) buyer.firstPurchaseAt = block.timestamp;
        buyer.totalPurchased += uqxAmount;
        totalSold += uqxAmount;

        IERC20(paymentToken).safeTransferFrom(msg.sender, fundsRecipient, paymentAmount);
        emit Purchased(msg.sender, paymentToken, paymentAmount, uqxAmount);
    }

    function vestedAmount(address buyerAddress) public view returns (uint256) {
        Buyer storage buyer = buyers[buyerAddress];
        if (buyer.firstPurchaseAt == 0) return 0;
        uint256 immediate = (buyer.totalPurchased * IMMEDIATE_BPS) / BPS_DENOMINATOR;
        uint256 remaining = buyer.totalPurchased - immediate;
        uint256 elapsed = block.timestamp - buyer.firstPurchaseAt;
        if (elapsed >= VESTING_DURATION) return buyer.totalPurchased;
        return immediate + (remaining * elapsed) / VESTING_DURATION;
    }

    function claimable(address buyerAddress) public view returns (uint256) {
        uint256 vested = vestedAmount(buyerAddress);
        uint256 already = buyers[buyerAddress].claimed;
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
        uint256 balance = uqx.balanceOf(address(this));
        uint256 outstanding = totalSold;
        require(balance > outstanding, "UqxPresale: nothing unsold to withdraw");
        uint256 unsold = balance - outstanding;
        uqx.safeTransfer(to, unsold);
        emit UnsoldWithdrawn(to, unsold);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
