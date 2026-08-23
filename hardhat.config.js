require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("dotenv").config({ quiet: true });

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.23",
    settings: {
      optimizer: { enabled: true, runs: 200 }
    }
  },
  networks: {
    hardhat: {},
    bsc: {
      url: process.env.BSC_DEPLOY_RPC_URL || "https://bsc-rpc.publicnode.com"
    },
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC_URL || "https://bsc-testnet-rpc.publicnode.com"
    }
  }
};
