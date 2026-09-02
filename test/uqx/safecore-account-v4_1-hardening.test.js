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
  const rescueTypes = {
    EmergencyRescue: [
      { name: "account", type: "address" },
      { name: "identity", type: "address" },
      { name: "rescueHash", type: "bytes32" },
      { name: "recoveryGeneration", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const spendTypes = {
    DeviceSpend: [
      { name: "account", type: "address" },
      { name: "device", type: "address" },
      { name: "asset", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
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

  it("permanently blocks an old trusted device from spending after emergency rescue", async function () {
    const { account, identity, deviceA, relayer, safe1, paper, domain } = await fixture();
    const accountAddress = await account.getAddress();
    await identity.sendTransaction({ to: accountAddress, value: ethers.parseEther("0.05") });

    const rescueAssets = [NATIVE];
    const rescueAmounts = [ethers.parseEther("0.04")];
    const rescueDestinations = [safe1.address];
    const rescueHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address[]", "uint256[]", "address[]"],
        [rescueAssets, rescueAmounts, rescueDestinations],
      ),
    );
    const rescueDeadline = BigInt((await time.latest()) + 3600);
    const rescueValue = {
      account: accountAddress,
      identity: identity.address,
      rescueHash,
      recoveryGeneration: await account.recoveryGeneration(),
      nonce: await account.identityNonce(),
      deadline: rescueDeadline,
    };
    const rescueSig = await identity.signTypedData(domain, rescueTypes, rescueValue);
    await account.connect(relayer).emergencyRescue(
      paper,
      rescueAssets,
      rescueAmounts,
      rescueDestinations,
      rescueDeadline,
      rescueSig,
    );
    expect(await account.recoveryCommitment()).to.equal(ethers.ZeroHash);

    // Leave 0.01 BNB in the retired account on purpose. Even a still-authorized
    // old Device A with a perfectly valid fresh signature must never move it.
    expect(await ethers.provider.getBalance(accountAddress)).to.equal(ethers.parseEther("0.01"));
    const spendDeadline = BigInt((await time.latest()) + 3600);
    const spendValue = {
      account: accountAddress,
      device: deviceA.address,
      asset: NATIVE,
      to: safe1.address,
      amount: ethers.parseEther("0.005"),
      nonce: await account.deviceNonce(deviceA.address),
      deadline: spendDeadline,
    };
    const spendSig = await deviceA.signTypedData(domain, spendTypes, spendValue);
    await expect(
      account.connect(deviceA).relaySpend(
        deviceA.address,
        NATIVE,
        safe1.address,
        spendValue.amount,
        spendDeadline,
        spendSig,
      ),
    ).to.be.revertedWithCustomError(account, "RecoveryNotArmed");
  });
});
