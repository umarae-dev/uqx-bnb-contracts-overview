const hre = require("hardhat");

async function main() {
  const hash = process.env.TX_HASH;
  const receipt = await hre.ethers.provider.getTransactionReceipt(hash);
  if (!receipt) {
    console.log("No receipt yet (pending or not found).");
    return;
  }
  console.log("status:", receipt.status);
  console.log("blockNumber:", receipt.blockNumber);
  console.log("contractAddress:", receipt.contractAddress);
  console.log("gasUsed:", receipt.gasUsed.toString());
  console.log("to:", receipt.to);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
