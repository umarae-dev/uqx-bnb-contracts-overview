// Deploys UqxPresale, whitelists USDT + USDC as accepted payment on BSC,
// and hands ownership to the SAME timelock that already controls
// UqxVesting (no new timelock needed — one multisig, one timelock,
// controlling every UQX contract).
//
//   npx hardhat run scripts/uqx/deployPresale.js --network bsc
//
// Required env vars:
//   UQX_TOKEN_ADDRESS — the already-deployed UqxToken.
//   UQX_TIMELOCK_ADDRESS — the already-deployed TimelockController.
//   UQX_TREASURY_ADDRESS — where presale payments (USDT/USDC) get
//     forwarded to on every purchase.
//   PAYMASTER_DEPLOYER_PRIVATE_KEY — the deployer wallet's private key.
const hre = require("hardhat");
const { ethers } = require("ethers");

// Real BSC mainnet addresses — verified on-chain (decimals() == 18 for
// both, confirmed before writing UqxPresale.sol's pricing math).
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const USDC_BSC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";

const PRESALE_CAP = 150_000_000n * 10n ** 18n;

async function main() {
  const tokenAddress = process.env.UQX_TOKEN_ADDRESS;
  const timelockAddress = process.env.UQX_TIMELOCK_ADDRESS;
  const treasury = process.env.UQX_TREASURY_ADDRESS;
  if (!tokenAddress) throw new Error("Set UQX_TOKEN_ADDRESS.");
  if (!timelockAddress) throw new Error("Set UQX_TIMELOCK_ADDRESS.");
  if (!treasury) throw new Error("Set UQX_TREASURY_ADDRESS.");

  const rpcUrl = process.env.BSC_DEPLOY_RPC_URL || "https://bsc-rpc.publicnode.com";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(process.env.PAYMASTER_DEPLOYER_PRIVATE_KEY, provider);
  console.log("Deploying from:", wallet.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "BNB");

  const presaleArtifact = await hre.artifacts.readArtifact("UqxPresale");
  const PresaleFactory = new ethers.ContractFactory(presaleArtifact.abi, presaleArtifact.bytecode, wallet);

  console.log("\nDeploying UqxPresale...");
  const presale = await PresaleFactory.deploy(tokenAddress, treasury);
  const deployTx = presale.deploymentTransaction();
  console.log("tx hash:", deployTx.hash);
  const receipt = await provider.waitForTransaction(deployTx.hash);
  if (receipt.status !== 1) throw new Error("UqxPresale deployment reverted!");
  const presaleAddress = receipt.contractAddress;
  console.log("UqxPresale deployed at:", presaleAddress, "(gas used:", receipt.gasUsed.toString() + ")");

  const presaleContract = new ethers.Contract(presaleAddress, presaleArtifact.abi, wallet);

  for (const [label, addr] of [["USDT", USDT_BSC], ["USDC", USDC_BSC]]) {
    console.log(`\nWhitelisting ${label} (${addr})...`);
    const tx = await presaleContract.setAcceptedPaymentToken(addr, true);
    console.log("tx hash:", tx.hash);
    const r = await provider.waitForTransaction(tx.hash);
    if (r.status !== 1) throw new Error(`Whitelisting ${label} reverted!`);
    console.log(`${label} accepted (gas used: ${r.gasUsed})`);
  }

  console.log("\nTransferring UqxPresale ownership to the existing timelock...");
  const transferTx = await presaleContract.transferOwnership(timelockAddress);
  console.log("tx hash:", transferTx.hash);
  const transferReceipt = await provider.waitForTransaction(transferTx.hash);
  if (transferReceipt.status !== 1) throw new Error("transferOwnership reverted!");
  console.log("Ownership transferred (gas used:", transferReceipt.gasUsed.toString() + ")");

  const currentOwner = await presaleContract.owner();
  console.log(
    "Verified UqxPresale.owner() =", currentOwner,
    currentOwner.toLowerCase() === timelockAddress.toLowerCase() ? "(matches timelock ✓)" : "(MISMATCH!)",
  );

  console.log("\n--- Next steps (manual, on purpose) ---");
  console.log(`1. From ${treasury}, transfer ${ethers.formatEther(PRESALE_CAP)} UQX (the full presale pool) to: ${presaleAddress}`);
  console.log("2. Build the presale page on zynost.com — connect wallet, approve USDT/USDC, call buy(token, amount).");
  console.log("3. Publish real presale terms & conditions before announcing it publicly.");
  console.log("\n--- Fill this in ---");
  console.log("UQX_PRESALE_ADDRESS =", presaleAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
