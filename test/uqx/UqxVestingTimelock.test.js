const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { buildMerkleTree } = require("./merkleHelper");

// Proves the exact deploy.js pattern actually works end-to-end: UqxVesting
// ownership handed to a TimelockController, proposing restricted to a
// "multisig" (simulated here by a single signer standing in for a real
// Safe{Wallet}), executing open to anyone once the delay has passed, and
// the delay itself being un-skippable.
describe("UqxVesting behind a TimelockController (multisig-controlled)", function () {
  const DAY = 24 * 60 * 60;
  const DELAY = 2 * DAY; // 48h, matching deploy.js's default

  async function deployBehindTimelock() {
    const [deployer, treasury, multisig, randomExecutor, alice] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("UqxToken");
    const token = await Token.deploy(treasury.address);

    const Vesting = await ethers.getContractFactory("UqxVesting");
    const vesting = await Vesting.deploy(await token.getAddress());

    const Timelock = await ethers.getContractFactory("TimelockController");
    const timelock = await Timelock.deploy(
      DELAY,
      [multisig.address],       // proposers
      [ethers.ZeroAddress],     // executors — open to everyone
      ethers.ZeroAddress,       // no separate admin
    );

    await vesting.transferOwnership(await timelock.getAddress());

    const amount = 1_000n * 10n ** 18n;
    await token.connect(treasury).transfer(await vesting.getAddress(), amount);
    const entries = [{ address: alice.address, amount, allocationType: 0 }];
    const tree = buildMerkleTree(entries);

    return { token, vesting, timelock, deployer, treasury, multisig, randomExecutor, alice, tree, entries, amount };
  }

  it("UqxVesting's owner really is the timelock, not the deployer", async function () {
    const { vesting, timelock } = await deployBehindTimelock();
    expect(await vesting.owner()).to.equal(await timelock.getAddress());
  });

  it("the deployer alone can no longer call setRoot directly", async function () {
    const { vesting, deployer, tree } = await deployBehindTimelock();
    const launch = (await time.latest()) + 3 * DAY;
    await expect(vesting.connect(deployer).setRoot(tree.root, launch)).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );
  });

  it("only the multisig can propose (schedule) an action — a random address cannot", async function () {
    const { vesting, timelock, randomExecutor, tree } = await deployBehindTimelock();
    const launch = (await time.latest()) + 3 * DAY;
    const data = vesting.interface.encodeFunctionData("setRoot", [tree.root, launch]);

    await expect(
      timelock.connect(randomExecutor).schedule(
        await vesting.getAddress(), 0, data, ethers.ZeroHash, ethers.ZeroHash, DELAY,
      ),
    ).to.be.reverted; // missing PROPOSER_ROLE
  });

  it("full real flow: multisig proposes setRoot, cannot execute early, anyone can execute after the delay", async function () {
    const { vesting, timelock, multisig, randomExecutor, tree } = await deployBehindTimelock();
    const launch = (await time.latest()) + 3 * DAY;
    const data = vesting.interface.encodeFunctionData("setRoot", [tree.root, launch]);
    const vestingAddress = await vesting.getAddress();

    await timelock.connect(multisig).schedule(vestingAddress, 0, data, ethers.ZeroHash, ethers.ZeroHash, DELAY);

    // Cannot execute before the delay has elapsed — not even the multisig.
    await expect(
      timelock.connect(multisig).execute(vestingAddress, 0, data, ethers.ZeroHash, ethers.ZeroHash),
    ).to.be.revertedWith("TimelockController: operation is not ready");

    await time.increase(DELAY);

    // Execution is open to anyone once ready — a completely unrelated
    // address can trigger it, proving proposing and executing are
    // genuinely separate powers.
    await timelock.connect(randomExecutor).execute(vestingAddress, 0, data, ethers.ZeroHash, ethers.ZeroHash);

    expect(await vesting.rootSet()).to.equal(true);
    expect(await vesting.merkleRoot()).to.equal(tree.root);
  });

  it("pause() also goes through the same proposer-then-delay-then-anyone-executes flow", async function () {
    const { vesting, timelock, multisig, randomExecutor } = await deployBehindTimelock();
    const vestingAddress = await vesting.getAddress();
    const pauseData = vesting.interface.encodeFunctionData("pause", []);

    await timelock.connect(multisig).schedule(vestingAddress, 0, pauseData, ethers.ZeroHash, ethers.ZeroHash, DELAY);
    await time.increase(DELAY);
    await timelock.connect(randomExecutor).execute(vestingAddress, 0, pauseData, ethers.ZeroHash, ethers.ZeroHash);

    expect(await vesting.paused()).to.equal(true);
  });
});
