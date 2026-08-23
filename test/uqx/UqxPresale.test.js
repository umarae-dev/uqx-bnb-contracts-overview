const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const PRICE = 5n * 10n ** 15n; // $0.005 in 18-decimal fixed point

describe("UqxPresale", function () {
  async function deployAll() {
    const [deployer, treasury, fundsRecipient, alice, bob] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("UqxToken");
    const token = await Token.deploy(treasury.address);

    const Presale = await ethers.getContractFactory("UqxPresale");
    const presale = await Presale.deploy(await token.getAddress(), fundsRecipient.address);

    // Fund the presale with the full 150M pool, exactly as deploy.js would.
    const PRESALE_CAP = 150_000_000n * 10n ** 18n;
    await token.connect(treasury).transfer(await presale.getAddress(), PRESALE_CAP);

    // A mock 18-decimal stablecoin standing in for real USDT/USDC.
    const Mock = await ethers.getContractFactory("ERC20PresetFixedSupply");
    const usdt = await Mock.deploy("Mock USDT", "USDT", 10_000_000n * 10n ** 18n, deployer.address);
    await usdt.transfer(alice.address, 100_000n * 10n ** 18n);
    await usdt.transfer(bob.address, 100_000n * 10n ** 18n);

    await presale.setAcceptedPaymentToken(await usdt.getAddress(), true);

    return { token, presale, usdt, deployer, treasury, fundsRecipient, alice, bob, PRESALE_CAP };
  }

  it("quotes the correct UQX amount for a given payment ($0.005/UQX)", async function () {
    const { presale } = await deployAll();
    // $100 should buy 100 / 0.005 = 20,000 UQX.
    const uqxAmount = await presale.quote(100n * 10n ** 18n);
    expect(uqxAmount).to.equal(20_000n * 10n ** 18n);
  });

  it("rejects payment in a non-accepted token", async function () {
    const { presale, alice } = await deployAll();
    const Random = await ethers.getContractFactory("ERC20PresetFixedSupply");
    const random = await Random.deploy("Random", "RND", 1000n * 10n ** 18n, alice.address);
    await random.connect(alice).approve(await presale.getAddress(), 100n * 10n ** 18n);
    await expect(presale.connect(alice).buy(await random.getAddress(), 100n * 10n ** 18n)).to.be.revertedWith(
      "UqxPresale: payment token not accepted",
    );
  });

  it("buying forwards payment straight to fundsRecipient and records the buyer's allocation", async function () {
    const { presale, usdt, alice, fundsRecipient } = await deployAll();
    const payment = 100n * 10n ** 18n; // $100
    await usdt.connect(alice).approve(await presale.getAddress(), payment);

    await presale.connect(alice).buy(await usdt.getAddress(), payment);

    expect(await usdt.balanceOf(fundsRecipient.address)).to.equal(payment);
    expect(await usdt.balanceOf(await presale.getAddress())).to.equal(0); // never custodies stablecoin

    const buyerInfo = await presale.buyers(alice.address);
    expect(buyerInfo.totalPurchased).to.equal(20_000n * 10n ** 18n);
    expect(await presale.totalSold()).to.equal(20_000n * 10n ** 18n);
  });

  it("20% is immediately claimable, rest vests linearly over 180 days from the buyer's own purchase", async function () {
    const { presale, token, usdt, alice } = await deployAll();
    const payment = 100n * 10n ** 18n;
    await usdt.connect(alice).approve(await presale.getAddress(), payment);
    await presale.connect(alice).buy(await usdt.getAddress(), payment);

    const total = 20_000n * 10n ** 18n;
    const expectedImmediate = (total * 2_000n) / 10_000n;
    expect(await presale.claimable(alice.address)).to.equal(expectedImmediate);

    await presale.connect(alice).claim();
    const claimedSoFar = (await presale.buyers(alice.address)).claimed;
    expect(claimedSoFar).to.be.at.least(expectedImmediate);
    expect(await token.balanceOf(alice.address)).to.equal(claimedSoFar);

    await time.increase(180 * DAY);
    expect(await presale.vestedAmount(alice.address)).to.equal(total);
    await presale.connect(alice).claim();
    expect(await token.balanceOf(alice.address)).to.equal(total);
  });

  it("a second purchase blends into the same vesting clock (starts from the FIRST purchase)", async function () {
    const { presale, usdt, alice } = await deployAll();
    await usdt.connect(alice).approve(await presale.getAddress(), 1000n * 10n ** 18n);

    await presale.connect(alice).buy(await usdt.getAddress(), 100n * 10n ** 18n); // 20,000 UQX
    const firstPurchaseAt = (await presale.buyers(alice.address)).firstPurchaseAt;

    await time.increase(30 * DAY);
    await presale.connect(alice).buy(await usdt.getAddress(), 100n * 10n ** 18n); // +20,000 UQX

    const info = await presale.buyers(alice.address);
    expect(info.totalPurchased).to.equal(40_000n * 10n ** 18n);
    expect(info.firstPurchaseAt).to.equal(firstPurchaseAt); // unchanged by the second buy
  });

  it("enforces the presale cap — cannot sell more than the 150M pool", async function () {
    const { presale, usdt, deployer, alice } = await deployAll();
    // Give alice (via the deployer's mock USDT) way more than the cap is worth.
    const hugePayment = 1_000_000n * 10n ** 18n; // would buy 200,000,000 UQX — over the 150M cap
    await usdt.transfer(alice.address, hugePayment);
    await usdt.connect(alice).approve(await presale.getAddress(), hugePayment);

    await expect(presale.connect(alice).buy(await usdt.getAddress(), hugePayment)).to.be.revertedWith(
      "UqxPresale: exceeds presale cap",
    );
  });

  it("pause() blocks both buy() and claim()", async function () {
    const { presale, usdt, alice } = await deployAll();
    await usdt.connect(alice).approve(await presale.getAddress(), 100n * 10n ** 18n);
    await presale.connect(alice).buy(await usdt.getAddress(), 100n * 10n ** 18n);

    await presale.pause();
    await expect(presale.connect(alice).buy(await usdt.getAddress(), 100n * 10n ** 18n)).to.be.revertedWith(
      "Pausable: paused",
    );
    await expect(presale.connect(alice).claim()).to.be.revertedWith("Pausable: paused");

    await presale.unpause();
    await presale.connect(alice).claim(); // works again
  });

  it("only the owner can withdraw unsold tokens, and only the truly-unsold amount", async function () {
    const { presale, token, usdt, alice, deployer, PRESALE_CAP } = await deployAll();
    await usdt.connect(alice).approve(await presale.getAddress(), 100n * 10n ** 18n);
    await presale.connect(alice).buy(await usdt.getAddress(), 100n * 10n ** 18n); // sells 20,000 UQX

    await expect(presale.connect(alice).withdrawUnsold(alice.address)).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );

    const sold = 20_000n * 10n ** 18n;
    await presale.connect(deployer).withdrawUnsold(deployer.address);
    expect(await token.balanceOf(deployer.address)).to.equal(PRESALE_CAP - sold);
    // What's left in the contract is exactly enough to cover the sold allocation.
    expect(await token.balanceOf(await presale.getAddress())).to.equal(sold);
  });
});
