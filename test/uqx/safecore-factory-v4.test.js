const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SafeCoreFactoryV4", function () {
  const NATIVE = ethers.ZeroAddress;
  const encodeRescuePayload = (assets, amounts, destinations) =>
    ethers.AbiCoder.defaultAbiCoder().encode(["address[]", "uint256[]", "address[]"], [assets, amounts, destinations]);

  async function fixture() {
    const [identity, deviceA, deviceB, safe1, safe2, relayer, attacker] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("SafeCoreFactoryV4");
    const factory = await Factory.deploy(); await factory.waitForDeployment();
    const secret = ethers.keccak256(ethers.toUtf8Bytes("factory-v4-paper"));
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret]));
    const config = { initialDevice: deviceA.address, emergencyAddress1: safe1.address, emergencyAddress2: safe2.address, recoveryCommitment: commitment, destinationChangeDelay: 2 * 24 * 60 * 60, initialAssets: [NATIVE], initialLimits: [ethers.parseEther("1")] };
    return { factory, identity, deviceA, deviceB, safe1, safe2, relayer, attacker, secret, config };
  }

  async function createSignature(factory, identity, configHash, nonce, deadline, signer = identity) {
    const network = await ethers.provider.getNetwork();
    const domain = { name: "SafeCoreFactoryV4", version: "1", chainId: network.chainId, verifyingContract: await factory.getAddress() };
    const types = { CreateSafeCore: [
      { name: "identity", type: "address" }, { name: "configHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] };
    return signer.signTypedData(domain, types, { identity: identity.address, configHash, nonce, deadline });
  }

  async function rescueSignature(account, identity, rescuePayload, successorHash, deadline) {
    const network = await ethers.provider.getNetwork();
    const domain = { name: "SafeCoreAccountV4", version: "1", chainId: network.chainId, verifyingContract: await account.getAddress() };
    const types = { EmergencyRescue: [
      { name: "account", type: "address" }, { name: "identity", type: "address" }, { name: "rescueHash", type: "bytes32" },
      { name: "successorConfigHash", type: "bytes32" }, { name: "recoveryGeneration", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] };
    return identity.signTypedData(domain, types, {
      account: await account.getAddress(), identity: identity.address, rescueHash: ethers.keccak256(rescuePayload), successorConfigHash: successorHash,
      recoveryGeneration: await account.recoveryGeneration(), nonce: await account.identityNonce(), deadline,
    });
  }

  it("lets a relayer deploy without receiving authority and records factory provenance", async function () {
    const { factory, identity, deviceA, relayer, config } = await fixture();
    const hash = await factory.configurationHash(config); const deadline = BigInt((await time.latest()) + 3600);
    await factory.connect(relayer).createAccountFor(identity.address, config, deadline, await createSignature(factory, identity, hash, 0n, deadline));
    const address = await factory.accountOf(identity.address);
    const account = await ethers.getContractAt("SafeCoreAccountV4_2", address);
    expect(await account.authorizedDevice(deviceA.address)).to.equal(true);
    expect(await account.authorizedDevice(relayer.address)).to.equal(false);
    expect(await factory.isFactoryAccount(address)).to.equal(true);
  });

  it("rejects relayer config tampering and attacker signatures", async function () {
    const { factory, identity, relayer, attacker, config } = await fixture();
    const configHash = await factory.configurationHash(config); const deadline = BigInt((await time.latest()) + 3600);
    const goodSig = await createSignature(factory, identity, configHash, 0n, deadline);
    await expect(factory.connect(relayer).createAccountFor(identity.address, { ...config, emergencyAddress1: attacker.address }, deadline, goodSig)).to.be.revertedWithCustomError(factory, "InvalidSignature");
    await expect(factory.connect(relayer).createAccountFor(identity.address, config, deadline, await createSignature(factory, identity, configHash, 0n, deadline, attacker))).to.be.revertedWithCustomError(factory, "InvalidSignature");
  });

  it("rejects second-account creation while recovery is armed", async function () {
    const { factory, identity, relayer, config } = await fixture();
    const hash = await factory.configurationHash(config); const deadline = BigInt((await time.latest()) + 3600); const sig = await createSignature(factory, identity, hash, 0n, deadline);
    await factory.connect(relayer).createAccountFor(identity.address, config, deadline, sig);
    await expect(factory.connect(relayer).createAccountFor(identity.address, config, deadline, sig)).to.be.revertedWithCustomError(factory, "AccountAlreadyExists");
  });

  it("replacement is locked to the canonical zero-budget successor committed by rescue", async function () {
    const { factory, identity, deviceA, deviceB, safe1, safe2, relayer, attacker, secret, config } = await fixture();
    const firstHash = await factory.configurationHash(config); let deadline = BigInt((await time.latest()) + 3600);
    await factory.connect(relayer).createAccountFor(identity.address, config, deadline, await createSignature(factory, identity, firstHash, 0n, deadline));
    const oldAddress = await factory.accountOf(identity.address); const oldAccount = await ethers.getContractAt("SafeCoreAccountV4_2", oldAddress);
    await identity.sendTransaction({ to: oldAddress, value: ethers.parseEther("0.02") });

    const newSecret = ethers.keccak256(ethers.toUtf8Bytes("replacement-card"));
    const newCommitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [newSecret]));
    const successor = { initialDevice: deviceB.address, emergencyAddress1: safe1.address, emergencyAddress2: safe2.address, recoveryCommitment: newCommitment, destinationChangeDelay: config.destinationChangeDelay, initialAssets: [], initialLimits: [] };
    const successorHash = await factory.configurationHash(successor);
    expect(await oldAccount.canonicalSuccessorConfigHash(deviceB.address, newCommitment)).to.equal(successorHash);

    const rescuePayload = encodeRescuePayload([NATIVE], [ethers.MaxUint256], [safe1.address]);
    deadline = BigInt((await time.latest()) + 3600);
    await oldAccount.connect(relayer).emergencyRescue(
      secret,
      rescuePayload,
      deviceB.address,
      newCommitment,
      deadline,
      await rescueSignature(oldAccount, identity, rescuePayload, successorHash, deadline),
    );
    expect(await oldAccount.successorConfigHash()).to.equal(successorHash);

    const attackerConfig = { ...successor, initialDevice: attacker.address };
    const attackerHash = await factory.configurationHash(attackerConfig);
    const nonce = await factory.creationNonce(identity.address); deadline = BigInt((await time.latest()) + 3600);
    await expect(factory.connect(attacker).createAccountFor(identity.address, attackerConfig, deadline, await createSignature(factory, identity, attackerHash, nonce, deadline))).to.be.revertedWithCustomError(factory, "ReplacementConfigMismatch");

    await factory.connect(relayer).createAccountFor(identity.address, successor, deadline, await createSignature(factory, identity, successorHash, nonce, deadline));
    const newAddress = await factory.accountOf(identity.address); const newAccount = await ethers.getContractAt("SafeCoreAccountV4_2", newAddress);
    expect(newAddress).to.not.equal(oldAddress);
    expect(await factory.isFactoryAccount(oldAddress)).to.equal(true);
    expect(await factory.isFactoryAccount(newAddress)).to.equal(true);
    expect(await newAccount.authorizedDevice(deviceB.address)).to.equal(true);
    expect(await newAccount.authorizedDevice(deviceA.address)).to.equal(false);
    expect(await newAccount.authorizedDevice(attacker.address)).to.equal(false);
    expect(await newAccount.recoveryCommitment()).to.equal(newCommitment);
    expect((await newAccount.budgetOf(NATIVE)).limit).to.equal(0n);

    await identity.sendTransaction({ to: oldAddress, value: ethers.parseEther("0.003") });
    const before = await ethers.provider.getBalance(safe2.address);
    await oldAccount.connect(relayer).sweepRetired(NATIVE, safe2.address);
    expect(await ethers.provider.getBalance(safe2.address)).to.equal(before + ethers.parseEther("0.003"));
  });
});
