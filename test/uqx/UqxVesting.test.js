const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { buildMerkleTree } = require("./merkleHelper");

const MINING = 0;
const PRESALE = 1;
const DAY = 24 * 60 * 60;

describe("UqxVesting", function () {
  async function deployWithEntries(entries) {
    const [deployer, treasury] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("UqxToken");
    const token = await Token.deploy(treasury.address);

    const Vesting = await ethers.getContractFactory("UqxVesting");
    const vesting = await Vesting.deploy(await token.getAddress());

    // Fund the vesting contract with enough tokens to cover every entry.
    const total = entries.reduce((sum, e) => sum + e.amount, 0n);
    await token.connect(treasury).transfer(await vesting.getAddress(), total);

    const tree = buildMerkleTree(entries);
    return { token, vesting, tree, deployer, treasury };
  }

  it("only the owner can set the root, and only once", async function () {
    const [, , alice] = await ethers.getSigners();
    const entries = [{ address: alice.address, amount: 100n, allocationType: MINING }];
    const { vesting, tree, deployer } = await deployWithEntries(entries);

    const future = (await time.latest()) + 60;
    await expect(vesting.connect(alice).setRoot(tree.root, future)).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );

    await vesting.connect(deployer).setRoot(tree.root, future);
    await expect(vesting.connect(deployer).setRoot(tree.root, future)).to.be.revertedWith(
      "UqxVesting: root already set",
    );
  });

  it("rejects a launch timestamp in the past", async function () {
    const { vesting, tree, deployer } = await deployWithEntries([
      { address: (await ethers.getSigners())[2].address, amount: 100n, allocationType: MINING },
    ]);
    const past = (await time.latest()) - 60;
    await expect(vesting.connect(deployer).setRoot(tree.root, past)).to.be.revertedWith(
      "UqxVesting: launch must not be in the past",
    );
  });

  it("rejects a zero root", async function () {
    const { vesting, deployer } = await deployWithEntries([]);
    const now = await time.latest();
    await expect(vesting.connect(deployer).setRoot(ethers.ZeroHash, now)).to.be.revertedWith(
      "UqxVesting: root is zero",
    );
  });

  it("nothing is claimable before the root is set or before launch", async function () {
    const [, , alice] = await ethers.getSigners();
    const amount = 1_000n * 10n ** 18n;
    const entries = [{ address: alice.address, amount, allocationType: MINING }];
    const { vesting, tree } = await deployWithEntries(entries);

    // Root never set.
    expect(await vesting.claimable(alice.address, amount, MINING)).to.equal(0n);

    const future = (await time.latest()) + 10 * DAY;
    await vesting.setRoot(tree.root, future);
    // Root set but launch is still in the future.
    expect(await vesting.claimable(alice.address, amount, MINING)).to.equal(0n);
  });

  it("mining allocation: 20% is immediately claimable at launch, rest vests over 240 days", async function () {
    const [, , alice] = await ethers.getSigners();
    const amount = 1_000n * 10n ** 18n;
    const entries = [{ address: alice.address, amount, allocationType: MINING }];
    const { token, vesting, tree } = await deployWithEntries(entries);

    const launch = (await time.latest()) + 60;
    await vesting.setRoot(tree.root, launch);
    await time.increaseTo(launch);

    const proof = tree.proofFor(entries[0]);
    const expectedImmediate = (amount * 2_000n) / 10_000n; // 20%
    expect(await vesting.claimable(alice.address, amount, MINING)).to.equal(expectedImmediate);

    // Note: the claim() transaction itself gets mined a moment after the
    // view call above, so the contract will legitimately have vested a
    // hair more by the time it executes — that's correct, continuous
    // vesting, not a bug. Check internal consistency instead of an assumed
    // external number: balance must equal whatever the contract itself
    // recorded as claimed, and that must be >= the 20% we observed a
    // moment earlier.
    await vesting.connect(alice).claim(amount, MINING, proof);
    const afterFirstClaim = await vesting.claimed(alice.address, MINING);
    expect(afterFirstClaim).to.be.at.least(expectedImmediate);
    expect(await token.balanceOf(alice.address)).to.equal(afterFirstClaim);

    // Partway through the 240-day vest: more has vested, and it must still
    // be strictly less than the full amount (still mid-vest).
    await time.increaseTo(launch + 120 * DAY);
    expect(await vesting.claimable(alice.address, amount, MINING)).to.be.above(0n);
    expect(await vesting.vestedAmount(amount, MINING)).to.be.below(amount);

    // Fully vested after 240 days — everything left is claimable.
    await time.increaseTo(launch + 240 * DAY);
    expect(await vesting.vestedAmount(amount, MINING)).to.equal(amount);
    await vesting.connect(alice).claim(amount, MINING, proof);
    expect(await token.balanceOf(alice.address)).to.equal(amount);

    // Fully vested, fully claimed: further time passing can't create more
    // (vestedAmount is capped at totalAmount), so this now genuinely has
    // nothing left — a real double-claim-protection check, not a
    // race against the block clock.
    await time.increase(DAY);
    await expect(vesting.connect(alice).claim(amount, MINING, proof)).to.be.revertedWith(
      "UqxVesting: nothing to claim",
    );
  });

  it("presale allocation vests over 180 days instead of 240", async function () {
    const [, , alice] = await ethers.getSigners();
    const amount = 500n * 10n ** 18n;
    const entries = [{ address: alice.address, amount, allocationType: PRESALE }];
    const { token, vesting, tree } = await deployWithEntries(entries);

    const launch = (await time.latest()) + 60;
    await vesting.setRoot(tree.root, launch);
    await time.increaseTo(launch + 180 * DAY);

    expect(await vesting.vestedAmount(amount, PRESALE)).to.equal(amount);
    const proof = tree.proofFor(entries[0]);
    await vesting.connect(alice).claim(amount, PRESALE, proof);
    expect(await token.balanceOf(alice.address)).to.equal(amount);
  });

  it("rejects an invalid proof", async function () {
    const [, , alice, mallory] = await ethers.getSigners();
    const amount = 1_000n * 10n ** 18n;
    const entries = [
      { address: alice.address, amount, allocationType: MINING },
      { address: mallory.address, amount, allocationType: MINING },
    ];
    const { vesting, tree } = await deployWithEntries(entries);

    const launch = (await time.latest()) + 60;
    await vesting.setRoot(tree.root, launch);
    await time.increaseTo(launch);

    // Mallory tries to claim using Alice's proof for her own address.
    const aliceProof = tree.proofFor(entries[0]);
    await expect(vesting.connect(mallory).claim(amount, MINING, aliceProof)).to.be.revertedWith(
      "UqxVesting: invalid proof",
    );
  });

  it("rejects a tampered amount even with a structurally valid-looking proof", async function () {
    const [, , alice] = await ethers.getSigners();
    const amount = 1_000n * 10n ** 18n;
    const entries = [{ address: alice.address, amount, allocationType: MINING }];
    const { vesting, tree } = await deployWithEntries(entries);

    const launch = (await time.latest()) + 60;
    await vesting.setRoot(tree.root, launch);
    await time.increaseTo(launch);

    const proof = tree.proofFor(entries[0]);
    const inflatedAmount = amount * 100n;
    await expect(vesting.connect(alice).claim(inflatedAmount, MINING, proof)).to.be.revertedWith(
      "UqxVesting: invalid proof",
    );
  });

  it("a single wallet holding BOTH a mining and a presale allocation can claim both independently", async function () {
    // Regression test for a real bug caught in review: claimed[] was
    // originally keyed by address alone, so claiming one allocation type
    // silently ate into the claimable balance of the other for any wallet
    // holding both. This is a completely realistic scenario — a miner
    // buying presale with the same wallet — not an edge case.
    const [, , alice] = await ethers.getSigners();
    const miningAmount = 1_000n * 10n ** 18n;
    const presaleAmount = 500n * 10n ** 18n;
    const entries = [
      { address: alice.address, amount: miningAmount, allocationType: MINING },
      { address: alice.address, amount: presaleAmount, allocationType: PRESALE },
    ];
    const { token, vesting, tree } = await deployWithEntries(entries);

    const launch = (await time.latest()) + 60;
    await vesting.setRoot(tree.root, launch);
    await time.increaseTo(launch + 365 * DAY); // fully vested on both schedules

    const miningProof = tree.proofFor(entries[0]);
    const presaleProof = tree.proofFor(entries[1]);

    await vesting.connect(alice).claim(miningAmount, MINING, miningProof);
    expect(await token.balanceOf(alice.address)).to.equal(miningAmount);

    // Before the fix, this would see claimable() == 0 because claimed[alice]
    // was already >= the (much smaller) presale vested amount.
    expect(await vesting.claimable(alice.address, presaleAmount, PRESALE)).to.equal(presaleAmount);
    await vesting.connect(alice).claim(presaleAmount, PRESALE, presaleProof);
    expect(await token.balanceOf(alice.address)).to.equal(miningAmount + presaleAmount);
  });

  it("supports many entries in one tree (mining + presale mixed)", async function () {
    const signers = await ethers.getSigners();
    const [, , ...users] = signers;
    const entries = users.slice(0, 6).map((u, i) => ({
      address: u.address,
      amount: BigInt(i + 1) * 10n ** 18n,
      allocationType: i % 2 === 0 ? MINING : PRESALE,
    }));
    const { token, vesting, tree } = await deployWithEntries(entries);

    const launch = (await time.latest()) + 60;
    await vesting.setRoot(tree.root, launch);
    await time.increaseTo(launch + 365 * DAY); // fully vested for everyone

    for (const entry of entries) {
      const proof = tree.proofFor(entry);
      const signer = await ethers.getSigner(entry.address);
      await vesting.connect(signer).claim(entry.amount, entry.allocationType, proof);
      expect(await token.balanceOf(entry.address)).to.equal(entry.amount);
    }
  });

  describe("emergency pause", function () {
    it("only the owner can pause or unpause", async function () {
      const [, , alice] = await ethers.getSigners();
      const { vesting } = await deployWithEntries([{ address: alice.address, amount: 100n, allocationType: MINING }]);
      await expect(vesting.connect(alice).pause()).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("blocks claim() while paused, without losing or altering vested progress", async function () {
      const [, , alice] = await ethers.getSigners();
      const amount = 1_000n * 10n ** 18n;
      const entries = [{ address: alice.address, amount, allocationType: MINING }];
      const { token, vesting, tree } = await deployWithEntries(entries);

      const launch = (await time.latest()) + 60;
      await vesting.setRoot(tree.root, launch);
      await time.increaseTo(launch + 365 * DAY); // fully vested

      const proof = tree.proofFor(entries[0]);
      await vesting.pause();

      // Vesting math keeps running in the background — it's just claim()
      // that's blocked, not the underlying entitlement.
      expect(await vesting.vestedAmount(amount, MINING)).to.equal(amount);
      await expect(vesting.connect(alice).claim(amount, MINING, proof)).to.be.revertedWith("Pausable: paused");

      await vesting.unpause();
      await vesting.connect(alice).claim(amount, MINING, proof);
      expect(await token.balanceOf(alice.address)).to.equal(amount);
    });
  });
});
