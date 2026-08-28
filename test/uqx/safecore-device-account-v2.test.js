const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SafeCoreDeviceAccountV2", function () {
  const ENROLL_DELAY = 60 * 60;
  const EMERGENCY_DELAY = 2 * 24 * 60 * 60;
  const NATIVE = ethers.ZeroAddress;

  async function fixture() {
    const [identity, recovery, veto, deviceA, deviceB, deviceC, receiver, attacker] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("SafeCoreDeviceAccountV2");
    const account = await Factory.deploy(
      identity.address,
      recovery.address,
      veto.address,
      deviceA.address,
      ENROLL_DELAY,
      EMERGENCY_DELAY,
      [NATIVE],
      [ethers.parseEther("1")]
    );
    await account.waitForDeployment();
    await identity.sendTransaction({ to: await account.getAddress(), value: ethers.parseEther("3") });
    return { account, identity, recovery, veto, deviceA, deviceB, deviceC, receiver, attacker };
  }

  async function enrollmentSignature(account, recovery, newDevice, nonce, deadline, emergency) {
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "SafeCoreDeviceAccountV2",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await account.getAddress(),
    };
    const types = {
      EnrollDevice: [
        { name: "account", type: "address" },
        { name: "newDevice", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "emergency", type: "bool" },
      ],
    };
    const value = {
      account: await account.getAddress(),
      newDevice,
      nonce,
      deadline,
      emergency,
    };
    return recovery.signTypedData(domain, types, value);
  }

  it("does not let the seed-derived identity spend protected funds", async function () {
    const { account, identity, receiver } = await fixture();
    await expect(
      account.connect(identity).spendNative(receiver.address, ethers.parseEther("0.01"))
    ).to.be.revertedWithCustomError(account, "Unauthorized");
  });

  it("lets an authorized device spend only inside its epoch budget", async function () {
    const { account, deviceA, receiver } = await fixture();
    await account.connect(deviceA).spendNative(receiver.address, ethers.parseEther("0.4"));
    await expect(
      account.connect(deviceA).spendNative(receiver.address, ethers.parseEther("0.7"))
    ).to.be.revertedWithCustomError(account, "BudgetExceeded");
  });

  it("rejects enrollment when the identity has no valid offline recovery signature", async function () {
    const { account, identity, deviceB, attacker } = await fixture();
    const deadline = (await time.latest()) + 3600;
    const badSig = await enrollmentSignature(account, attacker, deviceB.address, 0n, deadline, false);
    await expect(
      account.connect(identity).requestDeviceEnrollment(deviceB.address, deadline, badSig)
    ).to.be.revertedWithCustomError(account, "InvalidSignature");
  });

  it("requires identity + recovery signature + existing device approval + delay", async function () {
    const { account, identity, recovery, deviceA, deviceB, receiver } = await fixture();
    const nonce = await account.securityNonce();
    const deadline = (await time.latest()) + 24 * 60 * 60;
    const sig = await enrollmentSignature(account, recovery, deviceB.address, nonce, deadline, false);

    await account.connect(identity).requestDeviceEnrollment(deviceB.address, deadline, sig);
    await expect(account.activateDevice(deviceB.address)).to.be.revertedWithCustomError(account, "EnrollmentNotReady");

    await account.connect(deviceA).approveDeviceEnrollment(deviceB.address);
    await time.increase(ENROLL_DELAY + 1);
    await account.activateDevice(deviceB.address);
    expect(await account.authorizedDevice(deviceB.address)).to.equal(true);

    await account.connect(deviceB).spendNative(receiver.address, ethers.parseEther("0.1"));
  });

  it("does not allow a recovery signature to be replayed", async function () {
    const { account, identity, recovery, deviceB, deviceC } = await fixture();
    const nonce = await account.securityNonce();
    const deadline = (await time.latest()) + 24 * 60 * 60;
    const sig = await enrollmentSignature(account, recovery, deviceB.address, nonce, deadline, false);
    await account.connect(identity).requestDeviceEnrollment(deviceB.address, deadline, sig);

    await expect(
      account.connect(identity).requestDeviceEnrollment(deviceC.address, deadline, sig)
    ).to.be.revertedWithCustomError(account, "InvalidSignature");
  });

  it("allows veto to cancel emergency enrollment", async function () {
    const { account, identity, recovery, veto, deviceB } = await fixture();
    const nonce = await account.securityNonce();
    const deadline = (await time.latest()) + 24 * 60 * 60;
    const sig = await enrollmentSignature(account, recovery, deviceB.address, nonce, deadline, true);
    await account.connect(identity).requestEmergencyDeviceEnrollment(deviceB.address, deadline, sig);
    await account.connect(veto).cancelDeviceEnrollment(deviceB.address);
    await time.increase(EMERGENCY_DELAY + 1);
    await expect(account.activateDevice(deviceB.address)).to.be.revertedWithCustomError(account, "EnrollmentMissing");
  });

  it("supports delayed emergency recovery when the old device is lost", async function () {
    const { account, identity, recovery, deviceB } = await fixture();
    const nonce = await account.securityNonce();
    const deadline = (await time.latest()) + 3 * 24 * 60 * 60;
    const sig = await enrollmentSignature(account, recovery, deviceB.address, nonce, deadline, true);
    await account.connect(identity).requestEmergencyDeviceEnrollment(deviceB.address, deadline, sig);
    await time.increase(EMERGENCY_DELAY + 1);
    await account.activateDevice(deviceB.address);
    expect(await account.authorizedDevice(deviceB.address)).to.equal(true);
  });
});
