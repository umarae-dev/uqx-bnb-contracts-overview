const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("UqxToken", function () {
  async function deploy() {
    const [deployer, treasury] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("UqxToken");
    const token = await Token.deploy(treasury.address);
    return { token, deployer, treasury };
  }

  it("mints the full fixed supply to the treasury on deploy", async function () {
    const { token, treasury } = await deploy();
    const supply = await token.TOTAL_SUPPLY();
    expect(supply).to.equal(1_000_000_000n * 10n ** 18n);
    expect(await token.totalSupply()).to.equal(supply);
    expect(await token.balanceOf(treasury.address)).to.equal(supply);
  });

  it("has the right name, symbol, and decimals", async function () {
    const { token } = await deploy();
    expect(await token.name()).to.equal("Zynost UQX");
    expect(await token.symbol()).to.equal("UQX");
    expect(await token.decimals()).to.equal(18);
  });

  it("reverts if the treasury address is zero", async function () {
    const Token = await ethers.getContractFactory("UqxToken");
    await expect(Token.deploy(ethers.ZeroAddress)).to.be.revertedWith(
      "UqxToken: treasury is zero address",
    );
  });

  it("has no mint/owner-privileged function anywhere in its ABI", async function () {
    const { token } = await deploy();
    const names = token.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name);
    expect(names).to.not.include.members(["mint", "burn", "pause", "owner"]);
  });

  it("transfers normally between accounts, standard ERC20 behavior", async function () {
    const { token, treasury } = await deploy();
    const [, , alice] = await ethers.getSigners();
    await token.connect(treasury).transfer(alice.address, 1_000n * 10n ** 18n);
    expect(await token.balanceOf(alice.address)).to.equal(1_000n * 10n ** 18n);
  });
});
