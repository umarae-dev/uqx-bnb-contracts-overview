const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SafeCoreAccountV4", function () {
  const NATIVE = ethers.ZeroAddress;
  const DAY = 24 * 60 * 60;

  async function fixture() {
    const [identity, deviceA, deviceB, safe1, safe2, receiver, relayer, attacker] = await ethers.getSigners();
    const paperSecret = ethers.keccak256(ethers.toUtf8Bytes("paper-v4-secret"));
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [paperSecret]));
    const Factory = await ethers.getContractFactory("SafeCoreAccountV4");
    const config = {
      initialDevice: deviceA.address,
      emergencyAddress1: safe1.address,
      emergencyAddress2: safe2.address,
      recoveryCommitment: commitment,
      destinationChangeDelay: 2 * DAY,
      initialAssets: [NATIVE],
      initialLimits: [ethers.parseEther("2")],
    };
    const account = await Factory.deploy(identity.address, config);
    await account.waitForDeployment();
    await identity.sendTransaction({ to: await account.getAddress(), value: ethers.parseEther("5") });
    return { account, identity, deviceA, deviceB, safe1, safe2, receiver, relayer, attacker, paperSecret };
  }

  async function domain(account) {
    const network = await ethers.provider.getNetwork();
    return { name: "SafeCoreAccountV4", version: "1", chainId: network.chainId, verifyingContract: await account.getAddress() };
  }

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

  async function enroll(account, identity, deviceA, deviceB, relayer) {
    const pairingHash = ethers.keccak256(ethers.toUtf8Bytes("pairing-b"));
    const deadline = BigInt((await time.latest()) + 3600);
    const d = await domain(account);
    const accountAddress = await account.getAddress();
    const nonce = await account.enrollmentNonce();
    const value = { account: accountAddress, newDevice: deviceB.address, pairingHash, nonce, deadline };
    const identitySig = await identity.signTypedData(d, enrollTypes, value);
    const deviceSig = await deviceB.signTypedData(d, enrollTypes, value);
    await account.connect(relayer).requestDeviceEnrollment(deviceB.address, pairingHash, deadline, identitySig, deviceSig);

    const approvalValue = { account: accountAddress, newDevice: deviceB.address, pairingHash, enrollmentNonce: nonce, deadline };
    const approvalSig = await deviceA.signTypedData(d, approveTypes, approvalValue);
    await account.connect(relayer).activateDeviceWithApproval(deviceB.address, pairingHash, deviceA.address, deadline, approvalSig);
    return { pairingHash, deadline, identitySig, deviceSig, approvalSig };
  }

  it("does not let identity or arbitrary relayer spend protected funds", async function () {
    const { account, identity, relayer, receiver } = await fixture();
    await expect(account.connect(identity).relaySpend(identity.address, NATIVE, receiver.address, 1n, 9999999999n, "0x"))
      .to.be.revertedWithCustomError(account, "NotAuthorized");
    await expect(account.connect(relayer).relaySpend(relayer.address, NATIVE, receiver.address, 1n, 9999999999n, "0x"))
      .to.be.revertedWithCustomError(account, "NotAuthorized");
  });

  it("requires both identity and Device B proof for gasless enrollment", async function () {
    const { account, identity, deviceB, relayer, attacker } = await fixture();
    const pairingHash = ethers.keccak256(ethers.toUtf8Bytes("pairing-b"));
    const deadline = BigInt((await time.latest()) + 3600);
    const d = await domain(account);
    const value = {
      account: await account.getAddress(),
      newDevice: deviceB.address,
      pairingHash,
      nonce: await account.enrollmentNonce(),
      deadline,
    };
    const identitySig = await identity.signTypedData(d, enrollTypes, value);
    const badDeviceSig = await attacker.signTypedData(d, enrollTypes, value);
    await expect(account.connect(relayer).requestDeviceEnrollment(deviceB.address, pairingHash, deadline, identitySig, badDeviceSig))
      .to.be.revertedWithCustomError(account, "InvalidSignature");
  });

  it("lets a zero-gas Device B become authorized through relayed signatures", async function () {
    const { account, identity, deviceA, deviceB, relayer } = await fixture();
    await enroll(account, identity, deviceA, deviceB, relayer);
    expect(await account.authorizedDevice(deviceB.address)).to.equal(true);
  });

  it("relays an authorized device spend and rejects signature replay", async function () {
    const { account, deviceA, receiver, relayer } = await fixture();
    const amount = ethers.parseEther("0.4");
    const deadline = BigInt((await time.latest()) + 3600);
    const d = await domain(account);
    const value = {
      account: await account.getAddress(),
      device: deviceA.address,
      asset: NATIVE,
      to: receiver.address,
      amount,
      nonce: await account.deviceNonce(deviceA.address),
      deadline,
    };
    const sig = await deviceA.signTypedData(d, spendTypes, value);
    const before = await ethers.provider.getBalance(receiver.address);
    await account.connect(relayer).relaySpend(deviceA.address, NATIVE, receiver.address, amount, deadline, sig);
    expect(await ethers.provider.getBalance(receiver.address)).to.equal(before + amount);
    await expect(account.connect(relayer).relaySpend(deviceA.address, NATIVE, receiver.address, amount, deadline, sig))
      .to.be.revertedWithCustomError(account, "InvalidSignature");
  });

  it("still enforces the epoch loss budget on gasless spends", async function () {
    const { account, deviceA, receiver, relayer } = await fixture();
    const d = await domain(account);
    const deadline = BigInt((await time.latest()) + 3600);
    async function spend(amount) {
      const value = {
        account: await account.getAddress(), device: deviceA.address, asset: NATIVE,
        to: receiver.address, amount, nonce: await account.deviceNonce(deviceA.address), deadline,
      };
      const sig = await deviceA.signTypedData(d, spendTypes, value);
      return account.connect(relayer).relaySpend(deviceA.address, NATIVE, receiver.address, amount, deadline, sig);
    }
    await spend(ethers.parseEther("1.4"));
    await expect(spend(ethers.parseEther("0.7"))).to.be.revertedWithCustomError(account, "BudgetExceeded");
  });

  it("allows gasless emergency rescue only to the two pre-registered addresses", async function () {
    const { account, identity, safe1, attacker, relayer, paperSecret } = await fixture();
    const d = await domain(account);
    const deadline = BigInt((await time.latest()) + 3600);
    const assets = [NATIVE];
    const amounts = [ethers.parseEther("1")];

    const badDestinations = [attacker.address];
    await expect(account.connect(relayer).emergencyRescue(paperSecret, assets, amounts, badDestinations, deadline, "0x"))
      .to.be.revertedWithCustomError(account, "EmergencyDestinationOnly");

    const destinations = [safe1.address];
    const rescueHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address[]", "uint256[]", "address[]"], [assets, amounts, destinations])
    );
    const value = {
      account: await account.getAddress(),
      identity: identity.address,
      rescueHash,
      recoveryGeneration: await account.recoveryGeneration(),
      nonce: await account.identityNonce(),
      deadline,
    };
    const sig = await identity.signTypedData(d, rescueTypes, value);
    const before = await ethers.provider.getBalance(safe1.address);
    await account.connect(relayer).emergencyRescue(paperSecret, assets, amounts, destinations, deadline, sig);
    expect(await ethers.provider.getBalance(safe1.address)).to.equal(before + amounts[0]);
    expect(await account.recoveryCommitment()).to.equal(ethers.ZeroHash);
  });

  it("cannot reuse the paper Recovery Card after a successful rescue", async function () {
    const { account, identity, safe2, relayer, paperSecret } = await fixture();
    const d = await domain(account);
    const deadline = BigInt((await time.latest()) + 3600);
    const assets = [NATIVE];
    const amounts = [ethers.parseEther("0.2")];
    const destinations = [safe2.address];
    const rescueHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address[]", "uint256[]", "address[]"], [assets, amounts, destinations]));
    const value = {
      account: await account.getAddress(), identity: identity.address, rescueHash,
      recoveryGeneration: await account.recoveryGeneration(), nonce: await account.identityNonce(), deadline,
    };
    const sig = await identity.signTypedData(d, rescueTypes, value);
    await account.connect(relayer).emergencyRescue(paperSecret, assets, amounts, destinations, deadline, sig);
    await expect(account.connect(relayer).emergencyRescue(paperSecret, assets, amounts, destinations, deadline, sig))
      .to.be.revertedWithCustomError(account, "RecoveryNotArmed");
  });
});
