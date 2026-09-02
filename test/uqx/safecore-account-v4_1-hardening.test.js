const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SafeCoreAccountV4_1 hardening", function () {
  const NATIVE = ethers.ZeroAddress;
  const DAY = 24 * 60 * 60;
  const enrollTypes = { EnrollDevice: [
    { name: "account", type: "address" }, { name: "newDevice", type: "address" }, { name: "pairingHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ] };
  const approveTypes = { ApproveDevice: [
    { name: "account", type: "address" }, { name: "newDevice", type: "address" }, { name: "pairingHash", type: "bytes32" }, { name: "enrollmentNonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ] };
  const revokeTypes = { RevokeDevice: [
    { name: "account", type: "address" }, { name: "device", type: "address" }, { name: "target", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ] };
  const rescueTypes = { EmergencyRescue: [
    { name: "account", type: "address" }, { name: "identity", type: "address" }, { name: "rescueHash", type: "bytes32" },
    { name: "successorConfigHash", type: "bytes32" }, { name: "recoveryGeneration", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ] };
  const spendTypes = { DeviceSpend: [
    { name: "account", type: "address" }, { name: "device", type: "address" }, { name: "asset", type: "address" }, { name: "to", type: "address" },
    { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ] };

  async function fixture() {
    const [identity, deviceA, deviceB, relayer, safe1, safe2] = await ethers.getSigners();
    const paper = ethers.keccak256(ethers.toUtf8Bytes("paper-a"));
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [paper]));
    const Contract = await ethers.getContractFactory("SafeCoreAccountV4_1");
    const account = await Contract.deploy(identity.address, {
      initialDevice: deviceA.address, emergencyAddress1: safe1.address, emergencyAddress2: safe2.address,
      recoveryCommitment: commitment, destinationChangeDelay: DAY, initialAssets: [NATIVE], initialLimits: [ethers.parseEther("1")],
    });
    await account.waitForDeployment();
    const network = await ethers.provider.getNetwork();
    const domain = { name: "SafeCoreAccountV4", version: "1", chainId: network.chainId, verifyingContract: await account.getAddress() };
    return { account, identity, deviceA, deviceB, relayer, safe1, safe2, paper, domain };
  }

  async function enrollSecondDevice(ctx) {
    const { account, identity, deviceA, deviceB, relayer, domain } = ctx;
    const pairingHash = ethers.keccak256(ethers.toUtf8Bytes("pair-b"));
    const deadline = BigInt((await time.latest()) + 3600);
    const value = { account: await account.getAddress(), newDevice: deviceB.address, pairingHash, nonce: await account.enrollmentNonce(), deadline };
    await account.connect(relayer).requestDeviceEnrollment(deviceB.address, pairingHash, deadline, await identity.signTypedData(domain, enrollTypes, value), await deviceB.signTypedData(domain, enrollTypes, value));
    const pending = await account.pendingEnrollment(deviceB.address);
    const approveDeadline = BigInt((await time.latest()) + 3600);
    const approval = { account: await account.getAddress(), newDevice: deviceB.address, pairingHash, enrollmentNonce: pending.nonce, deadline: approveDeadline };
    await account.connect(relayer).activateDeviceWithApproval(deviceB.address, pairingHash, deviceA.address, approveDeadline, await deviceA.signTypedData(domain, approveTypes, approval));
  }

  it("keeps an enumerable exact trusted-device registry through activate and revoke", async function () {
    const ctx = await fixture();
    const { account, deviceA, deviceB, relayer, domain } = ctx;
    expect(Array.from(await account.authorizedDevices())).to.deep.equal([deviceA.address]);
    await enrollSecondDevice(ctx);
    expect(Array.from(await account.authorizedDevices())).to.have.members([deviceA.address, deviceB.address]);
    const deadline = BigInt((await time.latest()) + 3600);
    const value = { account: await account.getAddress(), device: deviceA.address, target: deviceB.address, nonce: await account.deviceNonce(deviceA.address), deadline };
    await account.connect(relayer).relayRevokeDevice(deviceA.address, deviceB.address, deadline, await deviceA.signTypedData(domain, revokeTypes, value));
    expect(Array.from(await account.authorizedDevices())).to.deep.equal([deviceA.address]);
  });

  it("never permits revocation of the last trusted device", async function () {
    const { account, deviceA, relayer, domain } = await fixture();
    const deadline = BigInt((await time.latest()) + 3600);
    const value = { account: await account.getAddress(), device: deviceA.address, target: deviceA.address, nonce: await account.deviceNonce(deviceA.address), deadline };
    await expect(account.connect(relayer).relayRevokeDevice(deviceA.address, deviceA.address, deadline, await deviceA.signTypedData(domain, revokeTypes, value)))
      .to.be.revertedWithCustomError(account, "LastDevice");
  });

  it("terminal rescue commits the canonical zero-budget successor and freezes old authority", async function () {
    const { account, identity, deviceA, deviceB, relayer, safe1, safe2, paper, domain } = await fixture();
    const accountAddress = await account.getAddress();
    await identity.sendTransaction({ to: accountAddress, value: ethers.parseEther("0.05") });
    const successorSecret = ethers.keccak256(ethers.toUtf8Bytes("successor-paper"));
    const successorCommitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [successorSecret]));
    const successorHash = await account.canonicalSuccessorConfigHash(deviceB.address, successorCommitment);

    const assets = [NATIVE]; const amounts = [ethers.parseEther("0.04")]; const destinations = [safe1.address];
    const rescueHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address[]", "uint256[]", "address[]"], [assets, amounts, destinations]));
    const deadline = BigInt((await time.latest()) + 3600);
    const value = { account: accountAddress, identity: identity.address, rescueHash, successorConfigHash: successorHash, recoveryGeneration: await account.recoveryGeneration(), nonce: await account.identityNonce(), deadline };
    const sig = await identity.signTypedData(domain, rescueTypes, value);
    await account.connect(relayer).emergencyRescue(paper, assets, amounts, destinations, deviceB.address, successorCommitment, deadline, sig);

    expect(await account.recoveryCommitment()).to.equal(ethers.ZeroHash);
    expect(await account.successorConfigHash()).to.equal(successorHash);
    expect(await account.isRetired()).to.equal(true);
    expect(await ethers.provider.getBalance(accountAddress)).to.equal(ethers.parseEther("0.01"));

    const spendDeadline = BigInt((await time.latest()) + 3600);
    const spendValue = { account: accountAddress, device: deviceA.address, asset: NATIVE, to: safe1.address, amount: ethers.parseEther("0.005"), nonce: await account.deviceNonce(deviceA.address), deadline: spendDeadline };
    const spendSig = await deviceA.signTypedData(domain, spendTypes, spendValue);
    await expect(account.connect(deviceA).relaySpend(deviceA.address, NATIVE, safe1.address, spendValue.amount, spendDeadline, spendSig)).to.be.revertedWithCustomError(account, "RetiredAccount");
    await expect(account.connect(deviceA).reduceBudgetImmediately(NATIVE, 0n)).to.be.revertedWithCustomError(account, "RetiredAccount");
    await expect(account.connect(relayer).sweepRetired(NATIVE, relayer.address)).to.be.revertedWithCustomError(account, "EmergencyDestinationOnly");

    const before = await ethers.provider.getBalance(safe2.address);
    await account.connect(relayer).sweepRetired(NATIVE, safe2.address);
    expect(await ethers.provider.getBalance(accountAddress)).to.equal(0n);
    expect(await ethers.provider.getBalance(safe2.address)).to.equal(before + ethers.parseEther("0.01"));
  });
});
