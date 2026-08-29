const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SafeCoreFactoryV3", function () {
  const NATIVE = ethers.ZeroAddress;

  it("creates one discoverable account per identity", async function () {
    const [identity, device, safe1, safe2] = await ethers.getSigners();
    const secret = ethers.keccak256(ethers.toUtf8Bytes("factory-paper-secret"));
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret]));

    const Factory = await ethers.getContractFactory("SafeCoreFactoryV3");
    const factory = await Factory.deploy();
    await factory.waitForDeployment();

    const tx = await factory.connect(identity).createMyAccount(
      device.address,
      safe1.address,
      safe2.address,
      commitment,
      2 * 24 * 60 * 60,
      [NATIVE],
      [ethers.parseEther("1")]
    );
    await tx.wait();

    const accountAddress = await factory.accountOf(identity.address);
    expect(accountAddress).to.not.equal(ethers.ZeroAddress);

    const account = await ethers.getContractAt("SafeCoreAccountV3", accountAddress);
    expect(await account.identity()).to.equal(identity.address);
    expect(await account.authorizedDevice(device.address)).to.equal(true);
    expect(await account.emergencyAddress1()).to.equal(safe1.address);
    expect(await account.emergencyAddress2()).to.equal(safe2.address);
  });

  it("rejects a second account for the same recovery identity", async function () {
    const [identity, device, safe1, safe2] = await ethers.getSigners();
    const secret = ethers.keccak256(ethers.toUtf8Bytes("factory-paper-secret"));
    const commitment = ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret]));

    const Factory = await ethers.getContractFactory("SafeCoreFactoryV3");
    const factory = await Factory.deploy();
    await factory.waitForDeployment();

    const args = [
      device.address,
      safe1.address,
      safe2.address,
      commitment,
      2 * 24 * 60 * 60,
      [NATIVE],
      [ethers.parseEther("1")],
    ];

    await factory.connect(identity).createMyAccount(...args);
    await expect(factory.connect(identity).createMyAccount(...args))
      .to.be.revertedWithCustomError(factory, "AccountAlreadyExists");
  });
});
