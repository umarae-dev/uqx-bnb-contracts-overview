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
    { name: "successorConfigHash", type: "bytes32" }, { name: "successorAuthority", type: "address" },
    { name: "recoveryGeneration", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ] };
  const rebindTypes = { RebindSuccessorDevice: [
    { name: "account", type: "address" }, { name: "newDevice", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ] };
  const spendTypes = { DeviceSpend: [
    { name: "account", type: "address" }, { name: "device", type: "address" }, { name: "asset", type: "address" }, { name: "to", type: "address" },
    { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ] };

  const encodeRescuePayload = (assets, amounts, destinations) =>
    ethers.AbiCoder.defaultAbiCoder().encode(["address[]", "uint256[]", "address[]"], [assets, amounts, destinations]);

  async function fixture() {
    const [identity, deviceA, deviceB, deviceC, relayer, safe1, safe2, successorAuthority, attacker] = await ethers.getSigners();
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
    return { account, identity, deviceA, deviceB, deviceC, relayer, safe1, safe2, successorAuthority, attacker, paper, domain };
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

  async function retire(ctx) {
    const { account, identity, deviceB, relayer, safe1, successorAuthority, paper, domain } = ctx;
    const successorSecret = ethers.keccak256(ethers.toUtf8Bytes("successor-paper"));
    const successorCommitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [successorSecret]));
    const successorHash = await account.canonicalSuccessorConfigHash(deviceB.address, successorCommitment);
    const rescuePayload = encodeRescuePayload([NATIVE], [ethers.parseEther("0.04")], [safe1.address]);
    const deadline = BigInt((await time.latest()) + 3600);
    const value = {
      account: await account.getAddress(), identity: identity.address, rescueHash: ethers.keccak256(rescuePayload), successorConfigHash: successorHash,
      successorAuthority: successorAuthority.address, recoveryGeneration: await account.recoveryGeneration(), nonce: await account.identityNonce(), deadline,
    };
    const sig = await identity.signTypedData(domain, rescueTypes, value);
    await account.connect(relayer).emergencyRescue(paper, rescuePayload, deviceB.address, successorCommitment, successorAuthority.address, deadline, sig);
    return { successorCommitment, successorHash, rescuePayload };
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

  it("terminal rescue commits canonical zero-budget successor, freezes old authority and restricts residual sweep", async function () {
    const ctx = await fixture();
    const { account, identity, deviceA, relayer, safe1, safe2 } = ctx;
    const accountAddress = await account.getAddress();
    await identity.sendTransaction({ to: accountAddress, value: ethers.parseEther("0.05") });
    const { successorHash, rescuePayload } = await retire(ctx);

    expect(await account.rescuePayloadHash(rescuePayload)).to.equal(ethers.keccak256(rescuePayload));
    expect(await account.recoveryCommitment()).to.equal(ethers.ZeroHash);
    expect(await account.successorConfigHash()).to.equal(successorHash);
    expect(await account.isRetired()).to.equal(true);
    expect(await ethers.provider.getBalance(accountAddress)).to.equal(ethers.parseEther("0.01"));

    const spendDeadline = BigInt((await time.latest()) + 3600);
    const spendValue = { account: accountAddress, device: deviceA.address, asset: NATIVE, to: safe1.address, amount: ethers.parseEther("0.005"), nonce: await account.deviceNonce(deviceA.address), deadline: spendDeadline };
    const spendSig = await deviceA.signTypedData(ctx.domain, spendTypes, spendValue);
    await expect(account.connect(deviceA).relaySpend(deviceA.address, NATIVE, safe1.address, spendValue.amount, spendDeadline, spendSig)).to.be.revertedWithCustomError(account, "RetiredAccount");
    await expect(account.connect(deviceA).reduceBudgetImmediately(NATIVE, 0n)).to.be.revertedWithCustomError(account, "RetiredAccount");
    await expect(account.connect(relayer).sweepRetired(NATIVE, relayer.address)).to.be.revertedWithCustomError(account, "EmergencyDestinationOnly");

    const before = await ethers.provider.getBalance(safe2.address);
    await account.connect(relayer).sweepRetired(NATIVE, safe2.address);
    expect(await ethers.provider.getBalance(accountAddress)).to.equal(0n);
    expect(await ethers.provider.getBalance(safe2.address)).to.equal(before + ethers.parseEther("0.01"));
  });

  it("lets only the NEW paper-card authority rebind a lost successor Device Key and blocks replay", async function () {
    const ctx = await fixture();
    const { account, identity, deviceC, successorAuthority, attacker, domain } = ctx;
    await identity.sendTransaction({ to: await account.getAddress(), value: ethers.parseEther("0.04") });
    const { successorCommitment, successorHash } = await retire(ctx);
    expect(await account.successorRecoveryAuthority()).to.equal(successorAuthority.address);
    expect(await account.successorRecoveryCommitment()).to.equal(successorCommitment);

    const deadline = BigInt((await time.latest()) + 3600);
    const nonce = await account.successorRebindNonce();
    const value = { account: await account.getAddress(), newDevice: deviceC.address, nonce, deadline };
    const badSig = await attacker.signTypedData(domain, rebindTypes, value);
    await expect(account.connect(attacker).rebindSuccessorDevice(deviceC.address, deadline, badSig)).to.be.revertedWithCustomError(account, "InvalidSignature");
    expect(await account.successorConfigHash()).to.equal(successorHash);
    expect(await account.successorRebindNonce()).to.equal(nonce);

    const goodSig = await successorAuthority.signTypedData(domain, rebindTypes, value);
    await account.connect(attacker).rebindSuccessorDevice(deviceC.address, deadline, goodSig);
    const rebound = await account.canonicalSuccessorConfigHash(deviceC.address, successorCommitment);
    expect(await account.successorConfigHash()).to.equal(rebound);
    expect(rebound).to.not.equal(successorHash);
    expect(await account.successorRebindNonce()).to.equal(nonce + 1n);

    await expect(account.connect(attacker).rebindSuccessorDevice(deviceC.address, deadline, goodSig)).to.be.revertedWithCustomError(account, "InvalidSignature");
  });
});
