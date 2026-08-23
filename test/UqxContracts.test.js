const { expect } = require("chai");
const { ethers } = require("hardhat");

const DAY = 24 * 60 * 60;

function leafFor(account, amount, allocationType) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint8"],
    [account, amount, allocationType]
  );
  const inner = ethers.keccak256(encoded);
  return ethers.keccak256(ethers.concat([inner]));
}

describe("UQX public contract reference", function () {
  it("mints the fixed 1B supply exactly once to treasury", async function () {
    const [treasury] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("UqxToken");
    const token = await Token.deploy(treasury.address);

    expect(await token.totalSupply()).to.equal(ethers.parseEther("1000000000"));
    expect(await token.balanceOf(treasury.address)).to.equal(await token.totalSupply());
  });

  it("rejects zero treasury", async function () {
    const Token = await ethers.getContractFactory("UqxToken");
    await expect(Token.deploy(ethers.ZeroAddress)).to.be.revertedWith(
      "UqxToken: treasury is zero address"
    );
  });

  it("vesting root is one-time and 20% is available at launch", async function () {
    const [owner, user] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("UqxToken");
    const token = await Token.deploy(owner.address);
    const Vesting = await ethers.getContractFactory("UqxVestingReference");
    const vesting = await Vesting.deploy(await token.getAddress());

    const total = ethers.parseEther("1000");
    const root = leafFor(user.address, total, 0);
    const block = await ethers.provider.getBlock("latest");
    const start = block.timestamp + 10;

    await token.transfer(await vesting.getAddress(), total);
    await vesting.setRoot(root, start);
    await expect(vesting.setRoot(root, start)).to.be.revertedWith("UqxVesting: root already set");

    await ethers.provider.send("evm_setNextBlockTimestamp", [start]);
    await ethers.provider.send("evm_mine");

    expect(await vesting.vestedAmount(total, 0)).to.equal((total * 2000n) / 10000n);
    await vesting.connect(user).claim(total, 0, []);
    expect(await token.balanceOf(user.address)).to.equal((total * 2000n) / 10000n);
  });

  it("vesting rejects invalid proof and owner can pause claims", async function () {
    const [owner, user, other] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("UqxToken");
    const token = await Token.deploy(owner.address);
    const Vesting = await ethers.getContractFactory("UqxVestingReference");
    const vesting = await Vesting.deploy(await token.getAddress());
    const total = ethers.parseEther("100");
    const root = leafFor(user.address, total, 0);
    const block = await ethers.provider.getBlock("latest");
    const start = block.timestamp + 1;

    await token.transfer(await vesting.getAddress(), total);
    await vesting.setRoot(root, start);
    await ethers.provider.send("evm_setNextBlockTimestamp", [start]);
    await ethers.provider.send("evm_mine");

    await expect(vesting.connect(other).claim(total, 0, [])).to.be.revertedWith("UqxVesting: invalid proof");
    await vesting.pause();
    await expect(vesting.connect(user).claim(total, 0, [])).to.be.revertedWith("Pausable: paused");
  });

  it("presale forwards payment directly and vests buyer allocation", async function () {
    const [owner, buyer, recipient] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("UqxToken");
    const token = await Token.deploy(owner.address);
    const Stable = await ethers.getContractFactory("MockStablecoin");
    const stable = await Stable.deploy();
    const Presale = await ethers.getContractFactory("UqxPresaleReference");
    const presale = await Presale.deploy(await token.getAddress(), recipient.address);

    await token.transfer(await presale.getAddress(), ethers.parseEther("150000000"));
    await presale.setAcceptedPaymentToken(await stable.getAddress(), true);

    const payment = ethers.parseEther("5");
    await stable.mint(buyer.address, payment);
    await stable.connect(buyer).approve(await presale.getAddress(), payment);
    await presale.connect(buyer).buy(await stable.getAddress(), payment);

    expect(await stable.balanceOf(recipient.address)).to.equal(payment);
    const purchased = (await presale.buyers(buyer.address)).totalPurchased;
    expect(purchased).to.equal(ethers.parseEther("1000"));
    expect(await presale.claimable(buyer.address)).to.be.greaterThan(0n);
  });

  it("presale enforces allowlist, cap and owner-only administration", async function () {
    const [owner, buyer, recipient, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("UqxToken");
    const token = await Token.deploy(owner.address);
    const Stable = await ethers.getContractFactory("MockStablecoin");
    const stable = await Stable.deploy();
    const Presale = await ethers.getContractFactory("UqxPresaleReference");
    const presale = await Presale.deploy(await token.getAddress(), recipient.address);

    await expect(
      presale.connect(outsider).setAcceptedPaymentToken(await stable.getAddress(), true)
    ).to.be.reverted;

    await stable.mint(buyer.address, ethers.parseEther("1"));
    await stable.connect(buyer).approve(await presale.getAddress(), ethers.parseEther("1"));
    await expect(
      presale.connect(buyer).buy(await stable.getAddress(), ethers.parseEther("1"))
    ).to.be.revertedWith("UqxPresale: payment token not accepted");
  });
});
