const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SafeCoreFactoryV4", function () {
  const NATIVE = ethers.ZeroAddress;

  async function fixture() {
    const [identity, device, safe1, safe2, relayer, attacker] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("SafeCoreFactoryV4");
    const factory = await Factory.deploy();
    await factory.waitForDeployment();
    const secret = ethers.keccak256(ethers.toUtf8Bytes("factory-v4-paper"));
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret]));
    const config = {
      initialDevice: device.address,
      emergencyAddress1: safe1.address,
      emergencyAddress2: safe2.address,
      recoveryCommitment: commitment,
      destinationChangeDelay: 2 * 24 * 60 * 60,
      initialAssets: [NATIVE],
      initialLimits: [ethers.parseEther("1")],
    };
    return { factory, identity, device, safe1, safe2, relayer, attacker, secret, commitment, config };
  }

  async function createSignature(factory, identity, configHash, nonce, deadline, signer = identity) {
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "SafeCoreFactoryV4",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await factory.getAddress(),
    };
    const types = {
      CreateSafeCore: [
        { name: "identity", type: "address" },
        { name: "configHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    return signer.signTypedData(domain, types, { identity: identity.address, configHash, nonce, deadline });
  }

  async function rescueSignature(account, identity, assets, amounts, destinations, deadline) {
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "SafeCoreAccountV4",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await account.getAddress(),
    };
    const types = {
      EmergencyRescue: [
        { name: "account", type: "address" },
        { name: "identity", type: "address" },
        { name: "rescueHash", type: "bytes32" },
        { name: "recoveryGeneration", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const rescueHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address[]", "uint256[]", "address[]"], [assets, amounts, destinations])
    );
    return identity.signTypedData(domain, types, {
      account: await account.getAddress(),
      identity: identity.address,
      rescueHash,
      recoveryGeneration: await account.recoveryGeneration(),
      nonce: await account.identityNonce(),
      deadline,
    });
  }

  it("lets a relayer deploy without receiving any account authority", async function () {
    const { factory, identity, device, relayer, config } = await fixture();
    const configHash = await factory.configurationHash(config);
    const nonce = await factory.creationNonce(identity.address);
    const deadline = BigInt((await time.latest()) + 3600);
    const sig = await createSignature(factory, identity, configHash, nonce, deadline);

    await factory.connect(relayer).createAccountFor(identity.address, config, deadline, sig);

    const accountAddress = await factory.accountOf(identity.address);
    expect(accountAddress).to.not.equal(ethers.ZeroAddress);
    const account = await ethers.getContractAt("SafeCoreAccountV4_2", accountAddress);
    expect(await account.identity()).to.equal(identity.address);
    expect(await account.authorizedDevice(device.address)).to.equal(true);
    expect(await account.authorizedDevice(relayer.address)).to.equal(false);
  });

  it("rejects config tampering by the relayer", async function () {
    const { factory, identity, relayer, attacker, config } = await fixture();
    const configHash = await factory.configurationHash(config);
    const deadline = BigInt((await time.latest()) + 3600);
    const sig = await createSignature(factory, identity, configHash, 0n, deadline);
    const tampered = { ...config, emergencyAddress1: attacker.address };

    await expect(factory.connect(relayer).createAccountFor(identity.address, tampered, deadline, sig))
      .to.be.revertedWithCustomError(factory, "InvalidSignature");
  });

  it("rejects attacker signatures and second-account creation while recovery is armed", async function () {
    const { factory, identity, relayer, attacker, config } = await fixture();
    const configHash = await factory.configurationHash(config);
    const deadline = BigInt((await time.latest()) + 3600);
    const badSig = await createSignature(factory, identity, configHash, 0n, deadline, attacker);
    await expect(factory.connect(relayer).createAccountFor(identity.address, config, deadline, badSig))
      .to.be.revertedWithCustomError(factory, "InvalidSignature");

    const goodSig = await createSignature(factory, identity, configHash, 0n, deadline, identity);
    await factory.connect(relayer).createAccountFor(identity.address, config, deadline, goodSig);
    await expect(factory.connect(relayer).createAccountFor(identity.address, config, deadline, goodSig))
      .to.be.revertedWithCustomError(factory, "AccountAlreadyExists");
  });

  it("allows a fresh account only after emergency rescue consumed the old Recovery Card", async function () {
    const { factory, identity, device, safe1, safe2, relayer, attacker, secret, config } = await fixture();

    const firstHash = await factory.configurationHash(config);
    const firstDeadline = BigInt((await time.latest()) + 3600);
    const firstSig = await createSignature(factory, identity, firstHash, 0n, firstDeadline);
    await factory.connect(relayer).createAccountFor(identity.address, config, firstDeadline, firstSig);

    const oldAddress = await factory.accountOf(identity.address);
    const oldAccount = await ethers.getContractAt("SafeCoreAccountV4_2", oldAddress);
    await identity.sendTransaction({ to: oldAddress, value: ethers.parseEther("0.02") });

    const assets = [NATIVE];
    const amounts = [ethers.MaxUint256];
    const destinations = [safe1.address];
    const rescueDeadline = BigInt((await time.latest()) + 3600);
    const rescueSig = await rescueSignature(oldAccount, identity, assets, amounts, destinations, rescueDeadline);
    await oldAccount.connect(relayer).emergencyRescue(secret, assets, amounts, destinations, rescueDeadline, rescueSig);
    expect(await oldAccount.recoveryCommitment()).to.equal(ethers.ZeroHash);

    const newSecret = ethers.keccak256(ethers.toUtf8Bytes("factory-v4-paper-replacement"));
    const newCommitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [newSecret]));
    const replacement = {
      ...config,
      initialDevice: attacker.address,
      emergencyAddress1: safe2.address,
      emergencyAddress2: safe1.address,
      recoveryCommitment: newCommitment,
    };
    const replacementHash = await factory.configurationHash(replacement);
    const replacementNonce = await factory.creationNonce(identity.address);
    const replacementDeadline = BigInt((await time.latest()) + 3600);
    const replacementSig = await createSignature(factory, identity, replacementHash, replacementNonce, replacementDeadline);

    await factory.connect(relayer).createAccountFor(identity.address, replacement, replacementDeadline, replacementSig);
    const newAddress = await factory.accountOf(identity.address);
    expect(newAddress).to.not.equal(oldAddress);

    const newAccount = await ethers.getContractAt("SafeCoreAccountV4_2", newAddress);
    expect(await newAccount.identity()).to.equal(identity.address);
    expect(await newAccount.authorizedDevice(attacker.address)).to.equal(true);
    expect(await newAccount.authorizedDevice(device.address)).to.equal(false);
    expect(await newAccount.recoveryCommitment()).to.equal(newCommitment);
  });
});
