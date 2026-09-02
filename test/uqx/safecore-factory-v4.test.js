const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SafeCoreFactoryV4", function () {
  const NATIVE = ethers.ZeroAddress;
  const encodeRescuePayload = (assets, amounts, destinations) =>
    ethers.AbiCoder.defaultAbiCoder().encode(["address[]", "uint256[]", "address[]"], [assets, amounts, destinations]);

  async function fixture() {
    const [identity, deviceA, deviceB, deviceC, safe1, safe2, relayer, attacker, successorAuthority] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("SafeCoreFactoryV4");
    const factory = await Factory.deploy(); await factory.waitForDeployment();
    const secret = ethers.keccak256(ethers.toUtf8Bytes("factory-v4-paper"));
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret]));
    const config = { initialDevice: deviceA.address, emergencyAddress1: safe1.address, emergencyAddress2: safe2.address, recoveryCommitment: commitment, destinationChangeDelay: 2 * 24 * 60 * 60, initialAssets: [NATIVE], initialLimits: [ethers.parseEther("1")] };
    return { factory, identity, deviceA, deviceB, deviceC, safe1, safe2, relayer, attacker, successorAuthority, secret, config };
  }

  async function createSignature(factory, identity, configHash, nonce, deadline, signer = identity) {
    const network = await ethers.provider.getNetwork();
    const domain = { name: "SafeCoreFactoryV4", version: "1", chainId: network.chainId, verifyingContract: await factory.getAddress() };
    const types = { CreateSafeCore: [
      { name: "identity", type: "address" }, { name: "configHash", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] };
    return signer.signTypedData(domain, types, { identity: identity.address, configHash, nonce, deadline });
  }

  async function rescueSignature(account, identity, rescuePayload, successorHash, successorAuthority, deadline) {
    const network = await ethers.provider.getNetwork();
    const domain = { name: "SafeCoreAccountV4", version: "1", chainId: network.chainId, verifyingContract: await account.getAddress() };
    const types = { EmergencyRescue: [
      { name: "account", type: "address" }, { name: "identity", type: "address" }, { name: "rescueHash", type: "bytes32" },
      { name: "successorConfigHash", type: "bytes32" }, { name: "successorAuthority", type: "address" },
      { name: "recoveryGeneration", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] };
    return identity.signTypedData(domain, types, {
      account: await account.getAddress(), identity: identity.address, rescueHash: ethers.keccak256(rescuePayload), successorConfigHash: successorHash,
      successorAuthority, recoveryGeneration: await account.recoveryGeneration(), nonce: await account.identityNonce(), deadline,
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

  it("blocks seed-only premature successor creation and survives loss of the initially committed successor phone", async function () {
    const { factory, identity, deviceA, deviceB, deviceC, safe1, safe2, relayer, attacker, successorAuthority, secret, config } = await fixture();
    const firstHash = await factory.configurationHash(config); let deadline = BigInt((await time.latest()) + 3600);
    await factory.connect(relayer).createAccountFor(identity.address, config, deadline, await createSignature(factory, identity, firstHash, 0n, deadline));
    const oldAddress = await factory.accountOf(identity.address); const oldAccount = await ethers.getContractAt("SafeCoreAccountV4_2", oldAddress);
    await identity.sendTransaction({ to: oldAddress, value: ethers.parseEther("0.02") });

    const newSecret = ethers.keccak256(ethers.toUtf8Bytes("replacement-card"));
    const newCommitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [newSecret]));
    const initialSuccessor = { initialDevice: deviceB.address, emergencyAddress1: safe1.address, emergencyAddress2: safe2.address, recoveryCommitment: newCommitment, destinationChangeDelay: config.destinationChangeDelay, initialAssets: [], initialLimits: [] };
    const initialHash = await factory.configurationHash(initialSuccessor);
    expect(await oldAccount.canonicalSuccessorConfigHash(deviceB.address, newCommitment)).to.equal(initialHash);

    const rescuePayload = encodeRescuePayload([NATIVE], [ethers.MaxUint256], [safe1.address]);
    deadline = BigInt((await time.latest()) + 3600);
    await oldAccount.connect(relayer).emergencyRescue(
      secret, rescuePayload, deviceB.address, newCommitment, successorAuthority.address, deadline,
      await rescueSignature(oldAccount, identity, rescuePayload, initialHash, successorAuthority.address, deadline),
    );
    expect(await oldAccount.successorConfigHash()).to.equal(initialHash);
    expect(await oldAccount.successorCreationAuthorizationHash()).to.equal(ethers.ZeroHash);

    // A seed-compromised attacker knows every public config field and can sign
    // the identity digest, but cannot prematurely instantiate the exact Device-B
    // successor before the NEW paper authority authorizes it.
    let nonce = await factory.creationNonce(identity.address); deadline = BigInt((await time.latest()) + 3600);
    await expect(
      factory.connect(attacker).createAccountFor(identity.address, initialSuccessor, deadline, await createSignature(factory, identity, initialHash, nonce, deadline)),
    ).to.be.revertedWithCustomError(factory, "ReplacementNotAuthorized");

    // Nor can the seed-only attacker substitute its own Device Key.
    const attackerConfig = { ...initialSuccessor, initialDevice: attacker.address };
    const attackerHash = await factory.configurationHash(attackerConfig);
    await expect(factory.connect(attacker).createAccountFor(identity.address, attackerConfig, deadline, await createSignature(factory, identity, attackerHash, nonce, deadline)))
      .to.be.revertedWithCustomError(factory, "ReplacementConfigMismatch");

    // NEW paper-card authority rebinds/authorizes only the Device Key to Device C.
    const network = await ethers.provider.getNetwork();
    const accountDomain = { name: "SafeCoreAccountV4", version: "1", chainId: network.chainId, verifyingContract: oldAddress };
    const rebindTypes = { RebindSuccessorDevice: [
      { name: "account", type: "address" }, { name: "newDevice", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] };
    const rebindNonce = await oldAccount.successorRebindNonce();
    const rebindDeadline = BigInt((await time.latest()) + 3600);
    const rebindValue = { account: oldAddress, newDevice: deviceC.address, nonce: rebindNonce, deadline: rebindDeadline };
    await oldAccount.connect(relayer).rebindSuccessorDevice(deviceC.address, rebindDeadline, await successorAuthority.signTypedData(accountDomain, rebindTypes, rebindValue));

    const reboundSuccessor = { ...initialSuccessor, initialDevice: deviceC.address };
    const reboundHash = await factory.configurationHash(reboundSuccessor);
    expect(await oldAccount.successorConfigHash()).to.equal(reboundHash);
    expect(await oldAccount.successorCreationAuthorizationHash()).to.equal(reboundHash);

    nonce = await factory.creationNonce(identity.address); deadline = BigInt((await time.latest()) + 3600);
    await factory.connect(relayer).createAccountFor(identity.address, reboundSuccessor, deadline, await createSignature(factory, identity, reboundHash, nonce, deadline));
    const newAddress = await factory.accountOf(identity.address); const newAccount = await ethers.getContractAt("SafeCoreAccountV4_2", newAddress);
    expect(newAddress).to.not.equal(oldAddress);
    expect(await factory.isFactoryAccount(oldAddress)).to.equal(true);
    expect(await factory.isFactoryAccount(newAddress)).to.equal(true);
    expect(await newAccount.authorizedDevice(deviceC.address)).to.equal(true);
    expect(await newAccount.authorizedDevice(deviceA.address)).to.equal(false);
    expect(await newAccount.authorizedDevice(deviceB.address)).to.equal(false);
    expect(await newAccount.authorizedDevice(attacker.address)).to.equal(false);
    expect(await newAccount.recoveryCommitment()).to.equal(newCommitment);
    expect((await newAccount.budgetOf(NATIVE)).limit).to.equal(0n);

    await identity.sendTransaction({ to: oldAddress, value: ethers.parseEther("0.003") });
    const before = await ethers.provider.getBalance(safe2.address);
    await oldAccount.connect(relayer).sweepRetired(NATIVE, safe2.address);
    expect(await ethers.provider.getBalance(safe2.address)).to.equal(before + ethers.parseEther("0.003"));
  });
});
