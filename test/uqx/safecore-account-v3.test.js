const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SafeCoreAccountV3", function () {
  const NATIVE = ethers.ZeroAddress;
  const DEST_CHANGE_DELAY = 2 * 24 * 60 * 60;
  const PAPER_SECRET = ethers.keccak256(ethers.toUtf8Bytes("paper-secret-alpha"));

  async function fixture() {
    const [identity, deviceA, deviceB, deviceC, safe1, safe2, safe3, attacker] = await ethers.getSigners();
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [PAPER_SECRET]));
    const Factory = await ethers.getContractFactory("SafeCoreAccountV3");
    const account = await Factory.deploy(
      identity.address,
      deviceA.address,
      safe1.address,
      safe2.address,
      commitment,
      DEST_CHANGE_DELAY,
      [NATIVE],
      [ethers.parseEther("2")]
    );
    await account.waitForDeployment();
    await identity.sendTransaction({ to: await account.getAddress(), value: ethers.parseEther("5") });
    return { account, identity, deviceA, deviceB, deviceC, safe1, safe2, safe3, attacker };
  }

  async function newDevicePairSignature(account, newDevice, pairingHash, nonce, deadline) {
    const network = await ethers.provider.getNetwork();
    return newDevice.signTypedData(
      {
        name: "SafeCoreAccountV3",
        version: "1",
        chainId: network.chainId,
        verifyingContract: await account.getAddress(),
      },
      {
        PairDevice: [
          { name: "account", type: "address" },
          { name: "newDevice", type: "address" },
          { name: "pairingHash", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        account: await account.getAddress(),
        newDevice: newDevice.address,
        pairingHash,
        nonce,
        deadline,
      }
    );
  }

  async function oldDeviceApprovalSignature(account, oldDevice, newDevice, pairingHash, enrollmentNonce, deadline) {
    const network = await ethers.provider.getNetwork();
    return oldDevice.signTypedData(
      {
        name: "SafeCoreAccountV3",
        version: "1",
        chainId: network.chainId,
        verifyingContract: await account.getAddress(),
      },
      {
        ApproveDevice: [
          { name: "account", type: "address" },
          { name: "newDevice", type: "address" },
          { name: "pairingHash", type: "bytes32" },
          { name: "enrollmentNonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        account: await account.getAddress(),
        newDevice: newDevice.address,
        pairingHash,
        enrollmentNonce,
        deadline,
      }
    );
  }

  async function requestPairing(ctx, newDevice = ctx.deviceB) {
    const pairingHash = ethers.keccak256(ethers.toUtf8Bytes("nearby-session-challenge"));
    const nonce = await ctx.account.securityNonce();
    const deadline = (await time.latest()) + 3600;
    const sig = await newDevicePairSignature(ctx.account, newDevice, pairingHash, nonce, deadline);
    await ctx.account.connect(ctx.identity).requestDeviceEnrollment(newDevice.address, pairingHash, deadline, sig);
    return { pairingHash, nonce, deadline };
  }

  it("does not let the seed-derived identity spend protected funds", async function () {
    const { account, identity, safe1 } = await fixture();
    await expect(account.connect(identity).spendNative(safe1.address, 1n))
      .to.be.revertedWithCustomError(account, "Unauthorized");
  });

  it("requires the new device itself to prove possession of its key", async function () {
    const ctx = await fixture();
    const pairingHash = ethers.keccak256(ethers.toUtf8Bytes("pair-A"));
    const nonce = await ctx.account.securityNonce();
    const deadline = (await time.latest()) + 3600;
    const forged = await newDevicePairSignature(ctx.account, ctx.attacker, pairingHash, nonce, deadline);

    await expect(
      ctx.account.connect(ctx.identity).requestDeviceEnrollment(ctx.deviceB.address, pairingHash, deadline, forged)
    ).to.be.revertedWithCustomError(ctx.account, "InvalidSignature");
  });

  it("does not activate Device B until an existing authorized device approves it", async function () {
    const ctx = await fixture();
    const { pairingHash } = await requestPairing(ctx);

    await expect(
      ctx.account.connect(ctx.identity).approveAndActivateDevice(ctx.deviceB.address, pairingHash)
    ).to.be.revertedWithCustomError(ctx.account, "Unauthorized");

    await ctx.account.connect(ctx.deviceA).approveAndActivateDevice(ctx.deviceB.address, pairingHash);
    expect(await ctx.account.authorizedDevice(ctx.deviceB.address)).to.equal(true);
  });

  it("supports offline nearby approval bound to the exact new device and pairing hash", async function () {
    const ctx = await fixture();
    const { pairingHash, nonce } = await requestPairing(ctx);
    const deadline = (await time.latest()) + 3600;
    const approval = await oldDeviceApprovalSignature(
      ctx.account,
      ctx.deviceA,
      ctx.deviceB,
      pairingHash,
      nonce,
      deadline
    );

    await ctx.account.connect(ctx.attacker).activateDeviceWithApprovalSignature(
      ctx.deviceB.address,
      pairingHash,
      ctx.deviceA.address,
      deadline,
      approval
    );

    expect(await ctx.account.authorizedDevice(ctx.deviceB.address)).to.equal(true);
  });

  it("rejects an old-device approval replayed against another pairing", async function () {
    const ctx = await fixture();
    const { pairingHash, nonce } = await requestPairing(ctx);
    const deadline = (await time.latest()) + 3600;
    const approval = await oldDeviceApprovalSignature(
      ctx.account,
      ctx.deviceA,
      ctx.deviceB,
      pairingHash,
      nonce,
      deadline
    );
    const wrongPairingHash = ethers.keccak256(ethers.toUtf8Bytes("different-nearby-session"));

    await expect(
      ctx.account.activateDeviceWithApprovalSignature(
        ctx.deviceB.address,
        wrongPairingHash,
        ctx.deviceA.address,
        deadline,
        approval
      )
    ).to.be.revertedWithCustomError(ctx.account, "PairingHashMismatch");
  });

  it("allows emergency rescue only to either of the two pre-registered safe addresses", async function () {
    const ctx = await fixture();
    const before1 = await ethers.provider.getBalance(ctx.safe1.address);
    const before2 = await ethers.provider.getBalance(ctx.safe2.address);

    await ctx.account.connect(ctx.identity).emergencyRescue(
      PAPER_SECRET,
      [NATIVE, NATIVE],
      [ethers.parseEther("1"), ethers.parseEther("1.5")],
      [ctx.safe1.address, ctx.safe2.address]
    );

    expect((await ethers.provider.getBalance(ctx.safe1.address)) - before1).to.equal(ethers.parseEther("1"));
    expect((await ethers.provider.getBalance(ctx.safe2.address)) - before2).to.equal(ethers.parseEther("1.5"));
  });

  it("hard-rejects every third-party destination during lost-device recovery", async function () {
    const ctx = await fixture();
    await expect(
      ctx.account.connect(ctx.identity).emergencyRescue(
        PAPER_SECRET,
        [NATIVE],
        [ethers.parseEther("1")],
        [ctx.attacker.address]
      )
    ).to.be.revertedWithCustomError(ctx.account, "EmergencyDestinationOnly");
  });

  it("does not let the paper recovery secret work without the seed-derived identity", async function () {
    const ctx = await fixture();
    await expect(
      ctx.account.connect(ctx.attacker).emergencyRescue(
        PAPER_SECRET,
        [NATIVE],
        [ethers.parseEther("1")],
        [ctx.safe1.address]
      )
    ).to.be.revertedWithCustomError(ctx.account, "Unauthorized");
  });

  it("burns the paper recovery secret after one successful emergency rescue", async function () {
    const ctx = await fixture();
    await ctx.account.connect(ctx.identity).emergencyRescue(
      PAPER_SECRET,
      [NATIVE],
      [ethers.parseEther("1")],
      [ctx.safe1.address]
    );

    expect(await ctx.account.recoveryCommitment()).to.equal(ethers.ZeroHash);

    await expect(
      ctx.account.connect(ctx.identity).emergencyRescue(
        PAPER_SECRET,
        [NATIVE],
        [ethers.parseEther("1")],
        [ctx.safe1.address]
      )
    ).to.be.revertedWithCustomError(ctx.account, "RecoveryNotArmed");
  });

  it("lets an authorized device arm a fresh recovery commitment after recovery", async function () {
    const ctx = await fixture();
    await ctx.account.connect(ctx.identity).emergencyRescue(
      PAPER_SECRET,
      [NATIVE],
      [ethers.parseEther("0.5")],
      [ctx.safe1.address]
    );

    const nextSecret = ethers.keccak256(ethers.toUtf8Bytes("paper-secret-beta"));
    const nextCommitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [nextSecret]));
    await ctx.account.connect(ctx.deviceA).armRecoveryCommitment(nextCommitment);
    expect(await ctx.account.recoveryCommitment()).to.equal(nextCommitment);
  });

  it("does not allow the identity or attacker to replace emergency addresses", async function () {
    const ctx = await fixture();
    await expect(
      ctx.account.connect(ctx.identity).requestEmergencyDestinationsChange(ctx.safe3.address, ctx.attacker.address)
    ).to.be.revertedWithCustomError(ctx.account, "Unauthorized");
    await expect(
      ctx.account.connect(ctx.attacker).requestEmergencyDestinationsChange(ctx.safe3.address, ctx.attacker.address)
    ).to.be.revertedWithCustomError(ctx.account, "Unauthorized");
  });

  it("delays emergency-address replacement even for an authorized device", async function () {
    const ctx = await fixture();
    await ctx.account.connect(ctx.deviceA).requestEmergencyDestinationsChange(ctx.safe2.address, ctx.safe3.address);

    await expect(ctx.account.applyEmergencyDestinationsChange())
      .to.be.revertedWithCustomError(ctx.account, "DestinationChangeNotReady");

    await time.increase(DEST_CHANGE_DELAY + 1);
    await ctx.account.applyEmergencyDestinationsChange();
    expect(await ctx.account.emergencyAddress1()).to.equal(ctx.safe2.address);
    expect(await ctx.account.emergencyAddress2()).to.equal(ctx.safe3.address);
  });

  it("keeps normal authorized-device spending bounded by the configured budget", async function () {
    const ctx = await fixture();
    await ctx.account.connect(ctx.deviceA).spendNative(ctx.safe1.address, ethers.parseEther("1.5"));
    await expect(
      ctx.account.connect(ctx.deviceA).spendNative(ctx.safe1.address, ethers.parseEther("0.6"))
    ).to.be.revertedWithCustomError(ctx.account, "BudgetExceeded");
  });
});
