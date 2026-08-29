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
    return { factory, identity, device, safe1, safe2, relayer, attacker, commitment, config };
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

  it("lets a relayer deploy without receiving any account authority", async function () {
    const { factory, identity, device, relayer, config } = await fixture();
    const configHash = await factory.configurationHash(config);
    const nonce = await factory.creationNonce(identity.address);
    const deadline = BigInt((await time.latest()) + 3600);
    const sig = await createSignature(factory, identity, configHash, nonce, deadline);

    await factory.connect(relayer).createAccountFor(identity.address, config, deadline, sig);

    const accountAddress = await factory.accountOf(identity.address);
    expect(accountAddress).to.not.equal(ethers.ZeroAddress);
    const account = await ethers.getContractAt("SafeCoreAccountV4", accountAddress);
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

  it("rejects attacker signatures and second-account creation", async function () {
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
});
