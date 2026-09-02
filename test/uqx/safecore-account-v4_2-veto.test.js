const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SafeCoreAccountV4_2 emergency-policy veto", function () {
  const DAY = 24 * 60 * 60;
  const changeTypes = {
    ChangeEmergencyDestinations: [
      { name: "account", type: "address" },
      { name: "device", type: "address" },
      { name: "first", type: "address" },
      { name: "second", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const cancelTypes = {
    CancelEmergencyDestinations: [
      { name: "account", type: "address" },
      { name: "device", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  async function fixture() {
    const [identity, deviceA, relayer, safe1, safe2, newSafe1, newSafe2, attacker] = await ethers.getSigners();
    const paper = ethers.keccak256(ethers.toUtf8Bytes("paper-v42"));
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [paper]));
    const Contract = await ethers.getContractFactory("SafeCoreAccountV4_2");
    const account = await Contract.deploy(identity.address, {
      initialDevice: deviceA.address,
      emergencyAddress1: safe1.address,
      emergencyAddress2: safe2.address,
      recoveryCommitment: commitment,
      destinationChangeDelay: DAY,
      initialAssets: [ethers.ZeroAddress],
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
    return { account, deviceA, relayer, safe1, safe2, newSafe1, newSafe2, attacker, domain };
  }

  async function queueChange(ctx) {
    const { account, deviceA, relayer, newSafe1, newSafe2, domain } = ctx;
    const deadline = BigInt((await time.latest()) + 3600);
    const value = {
      account: await account.getAddress(),
      device: deviceA.address,
      first: newSafe1.address,
      second: newSafe2.address,
      nonce: await account.deviceNonce(deviceA.address),
      deadline,
    };
    const sig = await deviceA.signTypedData(domain, changeTypes, value);
    await account.connect(relayer).requestEmergencyDestinationsChange(
      deviceA.address, newSafe1.address, newSafe2.address, deadline, sig,
    );
  }

  it("lets an authorized device veto a queued emergency-wallet weakening", async function () {
    const ctx = await fixture();
    const { account, deviceA, relayer, safe1, safe2, domain } = ctx;
    await queueChange(ctx);
    expect((await account.pendingEmergencyDestinations()).executableAt).to.be.greaterThan(0n);

    const deadline = BigInt((await time.latest()) + 3600);
    const value = {
      account: await account.getAddress(),
      device: deviceA.address,
      nonce: await account.deviceNonce(deviceA.address),
      deadline,
    };
    const sig = await deviceA.signTypedData(domain, cancelTypes, value);
    await account.connect(relayer).cancelEmergencyDestinationsChange(deviceA.address, deadline, sig);

    expect((await account.pendingEmergencyDestinations()).executableAt).to.equal(0n);
    expect(await account.emergencyAddress1()).to.equal(safe1.address);
    expect(await account.emergencyAddress2()).to.equal(safe2.address);
  });

  it("rejects an attacker veto and preserves the pending change", async function () {
    const ctx = await fixture();
    const { account, deviceA, relayer, attacker, domain } = ctx;
    await queueChange(ctx);
    const before = await account.pendingEmergencyDestinations();
    const deadline = BigInt((await time.latest()) + 3600);
    const value = {
      account: await account.getAddress(),
      device: deviceA.address,
      nonce: await account.deviceNonce(deviceA.address),
      deadline,
    };
    const badSig = await attacker.signTypedData(domain, cancelTypes, value);
    await expect(account.connect(relayer).cancelEmergencyDestinationsChange(deviceA.address, deadline, badSig))
      .to.be.revertedWithCustomError(account, "InvalidSignature");
    expect((await account.pendingEmergencyDestinations()).executableAt).to.equal(before.executableAt);
  });

  it("prevents replay of a successful veto signature through the shared device nonce", async function () {
    const ctx = await fixture();
    const { account, deviceA, relayer, domain } = ctx;
    await queueChange(ctx);
    const deadline = BigInt((await time.latest()) + 3600);
    const nonce = await account.deviceNonce(deviceA.address);
    const value = { account: await account.getAddress(), device: deviceA.address, nonce, deadline };
    const sig = await deviceA.signTypedData(domain, cancelTypes, value);
    await account.connect(relayer).cancelEmergencyDestinationsChange(deviceA.address, deadline, sig);

    await queueChange(ctx);
    await expect(account.connect(relayer).cancelEmergencyDestinationsChange(deviceA.address, deadline, sig))
      .to.be.revertedWithCustomError(account, "InvalidSignature");
  });
});
