const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SafeCoreAccountV1", function () {
  const ONE_DAY = 24 * 60 * 60;
  const MIN_DELAY = 48 * 60 * 60;
  const TOKEN_LIMIT = ethers.parseEther("100");
  const NATIVE_LIMIT = ethers.parseEther("1");
  const ZERO = ethers.ZeroAddress;

  async function fixture() {
    const [owner, recovery, veto, recipient, attacker, newOwner] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("UqxToken");
    const token = await Token.deploy(owner.address);
    await token.waitForDeployment();

    const SafeCore = await ethers.getContractFactory("SafeCoreAccountV1");
    const account = await SafeCore.deploy(
      owner.address,
      recovery.address,
      veto.address,
      MIN_DELAY,
      [ZERO, await token.getAddress()],
      [NATIVE_LIMIT, TOKEN_LIMIT]
    );
    await account.waitForDeployment();

    await token.transfer(await account.getAddress(), ethers.parseEther("1000"));
    await owner.sendTransaction({ to: await account.getAddress(), value: ethers.parseEther("5") });

    return { owner, recovery, veto, recipient, attacker, newOwner, token, account };
  }

  it("bounds ERC20 loss to the precommitted epoch budget", async function () {
    const { owner, recipient, token, account } = await fixture();

    await account.connect(owner).spendToken(token, recipient.address, ethers.parseEther("60"));
    await expect(
      account.connect(owner).spendToken(token, recipient.address, ethers.parseEther("41"))
    ).to.be.revertedWithCustomError(account, "BudgetExceeded");

    await account.connect(owner).spendToken(token, recipient.address, ethers.parseEther("40"));
    expect(await token.balanceOf(recipient.address)).to.equal(TOKEN_LIMIT);
  });

  it("bounds native loss independently", async function () {
    const { owner, recipient, account } = await fixture();

    await account.connect(owner).spendNative(recipient.address, ethers.parseEther("0.7"));
    await expect(
      account.connect(owner).spendNative(recipient.address, ethers.parseEther("0.31"))
    ).to.be.revertedWithCustomError(account, "BudgetExceeded");
  });

  it("resets spend only after an epoch", async function () {
    const { owner, recipient, token, account } = await fixture();

    await account.connect(owner).spendToken(token, recipient.address, TOKEN_LIMIT);
    await expect(
      account.connect(owner).spendToken(token, recipient.address, 1n)
    ).to.be.revertedWithCustomError(account, "BudgetExceeded");

    await time.increase(ONE_DAY + 1);
    await account.connect(owner).spendToken(token, recipient.address, ethers.parseEther("1"));
  });

  it("allows safety tightening immediately", async function () {
    const { owner, token, account } = await fixture();
    const asset = await token.getAddress();

    await account.connect(owner).reduceBudgetImmediately(asset, ethers.parseEther("10"));
    const budget = await account.budgetOf(asset);
    expect(budget.limit).to.equal(ethers.parseEther("10"));
  });

  it("never allows an owner to raise its own budget immediately", async function () {
    const { owner, token, account } = await fixture();
    const asset = await token.getAddress();
    const raised = ethers.parseEther("500");

    await account.connect(owner).requestBudgetIncrease(asset, raised);
    await expect(account.applyBudgetIncrease(asset)).to.be.revertedWithCustomError(account, "IncreaseNotReady");

    await time.increase(MIN_DELAY + 1);
    await account.applyBudgetIncrease(asset);
    const budget = await account.budgetOf(asset);
    expect(budget.limit).to.equal(raised);
  });

  it("lets veto or recovery cancel a pending security weakening", async function () {
    const { owner, recovery, veto, token, account } = await fixture();
    const asset = await token.getAddress();

    await account.connect(owner).requestBudgetIncrease(asset, ethers.parseEther("500"));
    await account.connect(veto).cancelBudgetIncrease(asset);
    expect((await account.pendingLimitIncrease(asset)).executableAt).to.equal(0);

    await account.connect(owner).requestBudgetIncrease(asset, ethers.parseEther("500"));
    await account.connect(recovery).cancelBudgetIncrease(asset);
    expect((await account.pendingLimitIncrease(asset)).executableAt).to.equal(0);
  });

  it("prevents recovery and veto keys from spending", async function () {
    const { recovery, veto, recipient, token, account } = await fixture();

    await expect(
      account.connect(recovery).spendToken(token, recipient.address, 1n)
    ).to.be.revertedWithCustomError(account, "Unauthorized");
    await expect(
      account.connect(veto).spendToken(token, recipient.address, 1n)
    ).to.be.revertedWithCustomError(account, "Unauthorized");
  });

  it("delays owner recovery and lets the old owner or veto cancel it", async function () {
    const { owner, recovery, veto, newOwner, account } = await fixture();

    await account.connect(recovery).requestOwnerRecovery(newOwner.address);
    await expect(account.applyOwnerRecovery()).to.be.revertedWithCustomError(account, "RecoveryNotReady");
    await account.connect(veto).cancelOwnerRecovery();
    expect((await account.pendingOwnerRecovery()).executableAt).to.equal(0);

    await account.connect(recovery).requestOwnerRecovery(newOwner.address);
    await account.connect(owner).cancelOwnerRecovery();
    expect((await account.pendingOwnerRecovery()).executableAt).to.equal(0);
  });

  it("rotates owner only after the immutable recovery delay", async function () {
    const { recovery, newOwner, recipient, token, account } = await fixture();

    await account.connect(recovery).requestOwnerRecovery(newOwner.address);
    await time.increase(MIN_DELAY + 1);
    await account.applyOwnerRecovery();
    expect(await account.owner()).to.equal(newOwner.address);

    await account.connect(newOwner).spendToken(token, recipient.address, ethers.parseEther("1"));
  });
});
