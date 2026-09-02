require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("dotenv").config({ quiet: true });

const defaultCompiler = {
  version: "0.8.23",
  settings: {
    optimizer: { enabled: true, runs: 200 }
  }
};

const sizeFocusedSafeCoreFactoryCompiler = {
  version: "0.8.23",
  settings: {
    // SafeCoreFactoryV4 embeds SafeCore account creation bytecode. Favor
    // deployable factory bytecode size without changing UQX compiler settings.
    optimizer: { enabled: true, runs: 1 }
  }
};

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    compilers: [defaultCompiler],
    overrides: {
      "contracts/SafeCoreFactoryV4.sol": sizeFocusedSafeCoreFactoryCompiler
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
