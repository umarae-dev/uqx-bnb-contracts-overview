const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SafeCoreAccountV4_2 delayed-budget veto", function () {
  const DAY = 24 * 60 * 60;
  const NATIVE = ethers.ZeroAddress;
  const budgetTypes = {
    ChangeBudget: [
      { name: "account", type: "address" },
      { name: "device", type: "address" },
      { name: "asset", type: "address" },
      { name: "newLimit", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const cancelTypes = {
    CancelBudgetIncrease: [
      { name: "account", type: "address" },
      { name: "device", type: "address" },
      { name: "asset", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  async function fixture() {
    const [identity, device, relayer, safe1, safe2, attacker] = await ethers.getSigners();
    const secret = ethers.keccak256(ethers.toUtf8Bytes("budget-veto-card"));
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret]));
    const Contract = await ethers.getContractFactory("SafeCoreAccountV4_2");
    const account = await Contract.deploy(identity.address, {
      initialDevice: device.address,
      emergencyAddress1: safe1.address,
      emergencyAddress2: safe2.address,
      recoveryCommitment: commitment,
      destinationChangeDelay: DAY,
      initialAssets: [NATIVE],
      initialLimits: [0],
    });
    await account.waitForDeployment();
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "SafeCoreAccountV4",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await account.getAddress(),
    };
    return { account, device, relayer, attacker, domain };
  }

  async function queueIncrease(ctx, newLimit = ethers.parseEther("1")) {
    const { account, device, relayer, domain } = ctx;
    const deadline = BigInt((await time.latest()) + 3600);
    const value = {
      account: await account.getAddress(),
      device: device.address,
      asset: NATIVE,
      newLimit,
      nonce: await account.deviceNonce(device.address),
      deadline,
    };
    const sig = await device.signTypedData(domain, budgetTypes, value);
    await account.connect(relayer).requestBudgetChange(device.address, NATIVE, newLimit, deadline, sig);
  }

  it("cancels a pending increase even when current budget is already zero", async function () {
    const ctx = await fixture();
    const { account, device, relayer, domain } = ctx;
    await queueIncrease(ctx);
    expect((await account.pendingBudgetChange(NATIVE)).executableAt).to.be.greaterThan(0n);

    const deadline = BigInt((await time.latest()) + 3600);
    const value = {
      account: await account.getAddress(),
      device: device.address,
      asset: NATIVE,
      nonce: await account.deviceNonce(device.address),
      deadline,
    };
    const sig = await device.signTypedData(domain, cancelTypes, value);
    await account.connect(relayer).cancelBudgetIncrease(device.address, NATIVE, deadline, sig);

    expect((await account.pendingBudgetChange(NATIVE)).executableAt).to.equal(0n);
    expect((await account.budgetOf(NATIVE)).limit).to.equal(0n);
  });

  it("rejects attacker cancellation and preserves the pending increase", async function () {
    const ctx = await fixture();
    const { account, device, relayer, attacker, domain } = ctx;
    await queueIncrease(ctx);
    const before = await account.pendingBudgetChange(NATIVE);
    const deadline = BigInt((await time.latest()) + 3600);
    const value = {
      account: await account.getAddress(),
      device: device.address,
      asset: NATIVE,
      nonce: await account.deviceNonce(device.address),
      deadline,
    };
    const badSig = await attacker.signTypedData(domain, cancelTypes, value);
    await expect(account.connect(relayer).cancelBudgetIncrease(device.address, NATIVE, deadline, badSig))
      .to.be.revertedWithCustomError(account, "InvalidSignature");
    expect((await account.pendingBudgetChange(NATIVE)).executableAt).to.equal(before.executableAt);
  });
});
