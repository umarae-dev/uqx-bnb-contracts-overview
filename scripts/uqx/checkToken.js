const hre = require("hardhat");

async function main() {
  const address = process.env.TOKEN_ADDRESS;
  const Token = await hre.ethers.getContractFactory("UqxToken");
  const token = Token.attach(address);
  console.log("name:", await token.name());
  console.log("symbol:", await token.symbol());
  console.log("totalSupply:", hre.ethers.formatEther(await token.totalSupply()));
  console.log("treasury balance:", hre.ethers.formatEther(await token.balanceOf(process.env.UQX_TREASURY_ADDRESS)));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
