const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SafeCoreAccountV4_1", function () {
  const NATIVE = ethers.ZeroAddress;
  const DAY = 24 * 60 * 60;
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

  async function fixture() {
    const [identity, device, relayer, attacker, safe1, safe2] = await ethers.getSigners();
    const paper = ethers.keccak256(ethers.toUtf8Bytes("v4.1-paper"));
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [paper]));
    const Contract = await ethers.getContractFactory("SafeCoreAccountV4_1");
    const account = await Contract.deploy(identity.address, {
      initialDevice: device.address,
      emergencyAddress1: safe1.address,
      emergencyAddress2: safe2.address,
      recoveryCommitment: commitment,
      destinationChangeDelay: DAY,
      initialAssets: [NATIVE],
      initialLimits: [ethers.parseEther("1")],
    });
    await account.waitForDeployment();
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "SafeCoreAccountV4",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await account.getAddress(),
    };
    return { account, identity, device, relayer, attacker, domain };
  }

  async function signBudget(account, signer, domain, newLimit) {
    const deadline = BigInt((await time.latest()) + 3600);
    const value = {
      account: await account.getAddress(),
      device: signer.address,
      asset: NATIVE,
      newLimit,
      nonce: await account.deviceNonce(signer.address),
      deadline,
    };
    return { deadline, sig: await signer.signTypedData(domain, budgetTypes, value) };
  }

  it("applies a signed budget reduction immediately and cancels a queued increase", async function () {
    const { account, device, relayer, domain } = await fixture();
    const increase = ethers.parseEther("2");
    let signed = await signBudget(account, device, domain, increase);
    await account.connect(relayer).requestBudgetChange(device.address, NATIVE, increase, signed.deadline, signed.sig);
    expect((await account.pendingBudgetChange(NATIVE)).newLimit).to.equal(increase);

    const reduced = ethers.parseEther("0.4");
    signed = await signBudget(account, device, domain, reduced);
    await account.connect(relayer).requestBudgetChange(device.address, NATIVE, reduced, signed.deadline, signed.sig);
    const budget = await account.budgetOf(NATIVE);
    expect(budget.limit).to.equal(reduced);
    expect((await account.pendingBudgetChange(NATIVE)).executableAt).to.equal(0n);
  });

  it("delays budget increases and lets anyone apply only the exact queued amount after the delay", async function () {
    const { account, device, relayer, attacker, domain } = await fixture();
    const newLimit = ethers.parseEther("2.5");
    const signed = await signBudget(account, device, domain, newLimit);
    await account.connect(relayer).requestBudgetChange(device.address, NATIVE, newLimit, signed.deadline, signed.sig);

    expect((await account.budgetOf(NATIVE)).limit).to.equal(ethers.parseEther("1"));
    await expect(account.connect(attacker).applyBudgetIncrease(NATIVE))
      .to.be.revertedWithCustomError(account, "BudgetIncreaseNotReady");

    await time.increase(DAY + 1);
    await account.connect(attacker).applyBudgetIncrease(NATIVE);
    expect((await account.budgetOf(NATIVE)).limit).to.equal(newLimit);
    expect((await account.pendingBudgetChange(NATIVE)).executableAt).to.equal(0n);
  });

  it("rejects an attacker signature and preserves the device nonce", async function () {
    const { account, device, attacker, relayer, domain } = await fixture();
    const deadline = BigInt((await time.latest()) + 3600);
    const nonceBefore = await account.deviceNonce(device.address);
    const value = {
      account: await account.getAddress(),
      device: device.address,
      asset: NATIVE,
      newLimit: ethers.parseEther("3"),
      nonce: nonceBefore,
      deadline,
    };
    const badSig = await attacker.signTypedData(domain, budgetTypes, value);
    await expect(account.connect(relayer).requestBudgetChange(device.address, NATIVE, value.newLimit, deadline, badSig))
      .to.be.revertedWithCustomError(account, "InvalidSignature");
    expect(await account.deviceNonce(device.address)).to.equal(nonceBefore);
  });

  it("rejects replay of a previously valid budget signature", async function () {
    const { account, device, relayer, domain } = await fixture();
    const limit = ethers.parseEther("0.5");
    const signed = await signBudget(account, device, domain, limit);
    await account.connect(relayer).requestBudgetChange(device.address, NATIVE, limit, signed.deadline, signed.sig);
    await expect(account.connect(relayer).requestBudgetChange(device.address, NATIVE, limit, signed.deadline, signed.sig))
      .to.be.revertedWithCustomError(account, "InvalidSignature");
  });
});
