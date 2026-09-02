const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SafeCoreAccountV4_1 hardening", function () {
  const NATIVE = ethers.ZeroAddress;
  const DAY = 24 * 60 * 60;

  const enrollTypes = {
    EnrollDevice: [
      { name: "account", type: "address" },
      { name: "newDevice", type: "address" },
      { name: "pairingHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const approveTypes = {
    ApproveDevice: [
      { name: "account", type: "address" },
      { name: "newDevice", type: "address" },
      { name: "pairingHash", type: "bytes32" },
      { name: "enrollmentNonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const revokeTypes = {
    RevokeDevice: [
      { name: "account", type: "address" },
      { name: "device", type: "address" },
      { name: "target", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const armTypes = {
    ArmRecovery: [
      { name: "account", type: "address" },
      { name: "device", type: "address" },
      { name: "commitment", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  async function fixture() {
    const [identity, deviceA, deviceB, relayer, safe1, safe2] = await ethers.getSigners();
    const paper = ethers.keccak256(ethers.toUtf8Bytes("paper-a"));
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [paper]));
    const Contract = await ethers.getContractFactory("SafeCoreAccountV4_1");
    const account = await Contract.deploy(identity.address, {
      initialDevice: deviceA.address,
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
    return { account, identity, deviceA, deviceB, relayer, safe1, safe2, paper, commitment, domain };
  }

  async function enrollSecondDevice(ctx) {
    const { account, identity, deviceA, deviceB, relayer, domain } = ctx;
    const accountAddress = await account.getAddress();
    const pairingHash = ethers.keccak256(ethers.toUtf8Bytes("pair-b"));
    const deadline = BigInt((await time.latest()) + 3600);
    const enrollmentNonce = await account.enrollmentNonce();
    const enrollValue = {
      account: accountAddress,
      newDevice: deviceB.address,
      pairingHash,
      nonce: enrollmentNonce,
      deadline,
    };
    const identitySig = await identity.signTypedData(domain, enrollTypes, enrollValue);
    const deviceSig = await deviceB.signTypedData(domain, enrollTypes, enrollValue);
    await account.connect(relayer).requestDeviceEnrollment(deviceB.address, pairingHash, deadline, identitySig, deviceSig);

    const pending = await account.pendingEnrollment(deviceB.address);
    const approveDeadline = BigInt((await time.latest()) + 3600);
    const approvalValue = {
      account: accountAddress,
      newDevice: deviceB.address,
      pairingHash,
      enrollmentNonce: pending.nonce,
      deadline: approveDeadline,
    };
    const approvalSig = await deviceA.signTypedData(domain, approveTypes, approvalValue);
    await account.connect(relayer).activateDeviceWithApproval(
      deviceB.address,
      pairingHash,
      deviceA.address,
      approveDeadline,
      approvalSig,
    );
  }

  it("keeps an enumerable exact trusted-device registry through activate and revoke", async function () {
    const ctx = await fixture();
    const { account, deviceA, deviceB, relayer, domain } = ctx;
    expect(Array.from(await account.authorizedDevices())).to.deep.equal([deviceA.address]);
    expect(await account.authorizedDeviceCount()).to.equal(1n);

    await enrollSecondDevice(ctx);
    const afterEnroll = Array.from(await account.authorizedDevices());
    expect(afterEnroll).to.have.members([deviceA.address, deviceB.address]);
    expect(await account.authorizedDeviceCount()).to.equal(2n);

    const deadline = BigInt((await time.latest()) + 3600);
    const nonce = await account.deviceNonce(deviceA.address);
    const value = {
      account: await account.getAddress(),
      device: deviceA.address,
      target: deviceB.address,
      nonce,
      deadline,
    };
    const sig = await deviceA.signTypedData(domain, revokeTypes, value);
    await account.connect(relayer).relayRevokeDevice(deviceA.address, deviceB.address, deadline, sig);

    expect(Array.from(await account.authorizedDevices())).to.deep.equal([deviceA.address]);
    expect(await account.authorizedDevice(deviceB.address)).to.equal(false);
    expect(await account.authorizedDeviceCount()).to.equal(1n);
  });

  it("never permits revocation of the last trusted device", async function () {
    const { account, deviceA, relayer, domain } = await fixture();
    const deadline = BigInt((await time.latest()) + 3600);
    const value = {
      account: await account.getAddress(),
      device: deviceA.address,
      target: deviceA.address,
      nonce: await account.deviceNonce(deviceA.address),
      deadline,
    };
    const sig = await deviceA.signTypedData(domain, revokeTypes, value);
    await expect(account.connect(relayer).relayRevokeDevice(deviceA.address, deviceA.address, deadline, sig))
      .to.be.revertedWithCustomError(account, "LastDevice");
  });

  it("blocks an authorized device from replacing an active Recovery Card", async function () {
    const { account, deviceA, relayer, domain, commitment } = await fixture();
    const replacement = ethers.keccak256(ethers.toUtf8Bytes("replacement-card"));
    const deadline = BigInt((await time.latest()) + 3600);
    const value = {
      account: await account.getAddress(),
      device: deviceA.address,
      commitment: replacement,
      nonce: await account.deviceNonce(deviceA.address),
      deadline,
    };
    const sig = await deviceA.signTypedData(domain, armTypes, value);
    await expect(account.connect(relayer).relayArmRecovery(deviceA.address, replacement, deadline, sig))
      .to.be.revertedWithCustomError(account, "RecoveryAlreadyArmed");
    expect(await account.recoveryCommitment()).to.equal(commitment);
  });
});
