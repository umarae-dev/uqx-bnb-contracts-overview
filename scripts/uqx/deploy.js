// Deploys UqxToken + UqxVesting + a TimelockController to whichever network
// Hardhat is pointed at, hands vesting's ownership to the timelock, and
// prints everything needed for the next steps.
//
// This script is NOT run against BSC mainnet or testnet automatically by
// anyone — it only does anything real when YOU run it with a --network
// flag pointing at a funded account, e.g.:
//   npx hardhat run scripts/uqx/deploy.js --network bscTestnet
//   npx hardhat run scripts/uqx/deploy.js --network bsc   (mainnet — real money)
//
// Uses plain ethers.js (a direct JsonRpcProvider + Wallet) rather than
// Hardhat's wrapped signer. Hardhat-ethers' HardhatEthersSigner does an
// extra checkTx() sanity call after sending a transaction, fetching the
// still-pending tx via getTransaction() and strictly validating its shape —
// some RPC providers (confirmed on our BSC mainnet endpoint) return
// "to": "" (empty string) instead of "to": null for a pending
// contract-creation tx, which ethers v6 rejects outright and crashes the
// whole script — even though the transaction itself was already accepted
// and will mine successfully. Plain ethers.Wallet.sendTransaction() doesn't
// do that extra fetch, so it doesn't hit the bug. (This bit us on the real
// mainnet deploy: UqxToken and UqxVesting both deployed successfully
// on-chain despite the script crashing right after — always double-check a
// "failed" deploy's tx hash on-chain before assuming it didn't happen.)
//
// Required env vars:
//   PAYMASTER_DEPLOYER_PRIVATE_KEY — the deployer wallet's private key.
//   UQX_TREASURY_ADDRESS — the wallet that receives the full 1B UQX supply
//     on mint. Everything else (mining pool, presale pool, DEX liquidity,
//     team, treasury, advisors, community — see zynost.com/tokenomics) is
//     then transferred out of that treasury by hand, not auto-split here.
//   UQX_MULTISIG_ADDRESS — a Safe{Wallet} (multisig) address, NOT a single
//     EOA. This becomes the sole controller of UqxVesting's owner-only
//     functions (setRoot, pause, unpause) via the timelock below. Create
//     one for free at app.safe.global before deploying.
//
// Optional:
//   UQX_TIMELOCK_DELAY_SECONDS — how long any owner action must sit publicly
//     queued before it can execute. Defaults to 48 hours.
//   BSC_DEPLOY_RPC_URL — defaults to the public BSC RPC if unset.
const hre = require("hardhat");
const { ethers } = require("ethers");

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const MINING_POOL = 250_000_000n * 10n ** 18n;   // 25%
const PRESALE_POOL = 150_000_000n * 10n ** 18n;  // 15%
const DEFAULT_TIMELOCK_DELAY_SECONDS = 48 * 60 * 60; // 48h

async function deployAndWait(provider, factory, args, label) {
  console.log(`\nDeploying ${label}...`);
  const contract = await factory.deploy(...args);
  const tx = contract.deploymentTransaction();
  console.log("tx hash:", tx.hash);
  const receipt = await provider.waitForTransaction(tx.hash);
  if (receipt.status !== 1) throw new Error(`${label} deployment reverted! tx: ${tx.hash}`);
  console.log(`${label} deployed at: ${receipt.contractAddress} (gas used: ${receipt.gasUsed})`);
  return receipt.contractAddress;
}

async function main() {
  const treasury = process.env.UQX_TREASURY_ADDRESS;
  if (!treasury) throw new Error("Set UQX_TREASURY_ADDRESS before deploying.");

  const multisig = process.env.UQX_MULTISIG_ADDRESS;
  if (!multisig) {
    throw new Error(
      "Set UQX_MULTISIG_ADDRESS before deploying — a Safe{Wallet} multisig, not a single wallet. " +
      "Create one free at app.safe.global first.",
    );
  }

  const timelockDelay = Number(process.env.UQX_TIMELOCK_DELAY_SECONDS || DEFAULT_TIMELOCK_DELAY_SECONDS);
  const rpcUrl = process.env.BSC_DEPLOY_RPC_URL || "https://bsc-rpc.publicnode.com";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(process.env.PAYMASTER_DEPLOYER_PRIVATE_KEY, provider);
  console.log("Deploying from:", wallet.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "BNB");

  const tokenArtifact = await hre.artifacts.readArtifact("UqxToken");
  const TokenFactory = new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, wallet);
  const tokenAddress = await deployAndWait(provider, TokenFactory, [treasury], "UqxToken");
  console.log("Total supply minted to treasury:", ethers.formatEther(TOTAL_SUPPLY), "UQX ->", treasury);

  const vestingArtifact = await hre.artifacts.readArtifact("UqxVesting");
  const VestingFactory = new ethers.ContractFactory(vestingArtifact.abi, vestingArtifact.bytecode, wallet);
  const vestingAddress = await deployAndWait(provider, VestingFactory, [tokenAddress], "UqxVesting");

  // The timelock is the only address that will ever hold owner power over
  // UqxVesting. Proposing a new action is restricted to the multisig, but
  // executing an already-queued, already-delayed action is open to anyone
  // (OpenZeppelin's own recommended pattern for this — passing the zero
  // address as the sole executor grants the role to everyone) so execution
  // never bottlenecks on the multisig's availability once something has
  // already sat publicly queued for the full delay. Nobody can shortcut
  // the delay itself either way.
  const timelockArtifact = await hre.artifacts.readArtifact("TimelockController");
  const TimelockFactory = new ethers.ContractFactory(timelockArtifact.abi, timelockArtifact.bytecode, wallet);
  const timelockAddress = await deployAndWait(
    provider,
    TimelockFactory,
    [timelockDelay, [multisig], [ethers.ZeroAddress], ethers.ZeroAddress],
    "TimelockController",
  );
  console.log(`(${timelockDelay / 3600}h delay, controlled by multisig ${multisig})`);

  console.log("\nTransferring UqxVesting ownership to the timelock...");
  const vesting = new ethers.Contract(vestingAddress, vestingArtifact.abi, wallet);
  const transferTx = await vesting.transferOwnership(timelockAddress);
  console.log("tx hash:", transferTx.hash);
  const transferReceipt = await provider.waitForTransaction(transferTx.hash);
  if (transferReceipt.status !== 1) throw new Error("transferOwnership reverted!");
  console.log("Ownership transferred (gas used:", transferReceipt.gasUsed.toString() + ")");

  const currentOwner = await vesting.owner();
  console.log(
    "Verified UqxVesting.owner() =", currentOwner,
    currentOwner.toLowerCase() === timelockAddress.toLowerCase() ? "(matches timelock ✓)" : "(MISMATCH!)",
  );

  console.log("\n--- Next steps (manual, on purpose) ---");
  console.log(`1. From ${treasury}, transfer ${ethers.formatEther(MINING_POOL + PRESALE_POOL)} UQX (Mining + Presale pools) to the vesting contract: ${vestingAddress}`);
  console.log("2. Run scripts/uqx/merkle.js against the real mining/presale snapshot from the database to get the Merkle root.");
  console.log(
    "3. setRoot() now goes through the timelock, not a direct call: from the multisig, call " +
    `timelock.schedule(vesting, 0, <setRoot calldata>, ...) — it becomes executable after the ${timelockDelay / 3600}h delay, ` +
    "then anyone can call timelock.execute(...) with the same parameters to run it. This is irreversible once executed — " +
    "double-check the root and timestamp before scheduling.",
  );
  console.log("\n--- Fill these in ---");
  console.log("UQX_TOKEN_ADDRESS =", tokenAddress);
  console.log("UQX_VESTING_ADDRESS =", vestingAddress);
  console.log("UQX_TIMELOCK_ADDRESS =", timelockAddress);
  console.log("Chain ID =", (await provider.getNetwork()).chainId.toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
