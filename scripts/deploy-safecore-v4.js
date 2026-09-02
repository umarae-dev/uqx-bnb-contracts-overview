require("dotenv").config({ quiet: true });
const hre = require("hardhat");
const { ethers } = hre;

/**
 * SafeCore V4 factory deployer.
 *
 * The private key is read only from the local environment and is never logged.
 * Mainnet deployment is permitted only with an explicit operator acknowledgement
 * that this pre-audit deployment is for tiny-fund acceptance testing. Do not use
 * significant funds or market SafeCore as independently audited until an actual
 * third-party audit has been completed.
 */
async function main() {
  const networkName = (process.env.SAFECORE_NETWORK || "bscTestnet").trim();
  const privateKey = (process.env.SAFECORE_DEPLOYER_PRIVATE_KEY || "").trim();
  if (!privateKey) {
    throw new Error("SAFECORE_DEPLOYER_PRIVATE_KEY is required in the local environment. Never commit it.");
  }

  const networks = {
    bscTestnet: {
      chainId: 97n,
      rpc: process.env.BSC_TESTNET_RPC_URL || "https://bsc-testnet-rpc.publicnode.com",
      label: "BNB Smart Chain Testnet",
    },
    bsc: {
      chainId: 56n,
      rpc: process.env.BSC_DEPLOY_RPC_URL || "https://bsc-rpc.publicnode.com",
      label: "BNB Smart Chain Mainnet",
    },
  };
  const config = networks[networkName];
  if (!config) throw new Error("SAFECORE_NETWORK must be bscTestnet or bsc.");

  if (networkName === "bsc" && process.env.SAFECORE_MAINNET_TEST_ACK !== "I_ACCEPT_UNAUDITED_MAINNET_TEST_RISK") {
    throw new Error(
      "Mainnet deployment blocked until the operator explicitly acknowledges pre-audit tiny-fund testing risk. " +
      "For a deliberate mainnet acceptance test, set SAFECORE_MAINNET_TEST_ACK=I_ACCEPT_UNAUDITED_MAINNET_TEST_RISK locally. " +
      "Do not use significant funds or claim an external audit unless one has actually been completed."
    );
  }

  const provider = new ethers.JsonRpcProvider(config.rpc);
  const network = await provider.getNetwork();
  if (network.chainId !== config.chainId) {
    throw new Error(`Wrong RPC chain: expected ${config.chainId}, received ${network.chainId}.`);
  }

  const signer = new ethers.Wallet(privateKey, provider);
  const balance = await provider.getBalance(signer.address);
  if (balance === 0n) throw new Error("SafeCore deployer has no native BNB for deployment gas.");

  console.log(`Network: ${config.label} (${config.chainId})`);
  console.log(`Deployer: ${signer.address}`);
  console.log("Deploying SafeCoreFactoryV4…");

  const Factory = await ethers.getContractFactory("SafeCoreFactoryV4", signer);
  const factory = await Factory.deploy();
  const tx = factory.deploymentTransaction();
  if (!tx) throw new Error("Deployment transaction was not created.");
  console.log(`Deployment tx: ${tx.hash}`);

  const receipt = await tx.wait(2);
  if (!receipt || receipt.status !== 1) throw new Error("SafeCoreFactoryV4 deployment reverted.");

  const address = await factory.getAddress();
  const code = await provider.getCode(address);
  if (!code || code === "0x") throw new Error("Factory deployment has no bytecode at the resulting address.");

  const deployedBytes = (code.length - 2) / 2;
  if (deployedBytes > 24_576) {
    throw new Error(`Factory runtime bytecode exceeds EIP-170: ${deployedBytes} bytes.`);
  }

  const accountProbe = await factory.accountOf(signer.address);
  const nonceProbe = await factory.creationNonce(signer.address);
  if (accountProbe !== ethers.ZeroAddress || nonceProbe !== 0n) {
    throw new Error("Factory initial public state probe failed.");
  }

  const domain = {
    name: "SafeCoreFactoryV4",
    version: "1",
    chainId: config.chainId,
    verifyingContract: address,
  };
  const domainHash = ethers.TypedDataEncoder.hashDomain(domain);
  if (!/^0x[0-9a-fA-F]{64}$/.test(domainHash)) throw new Error("Factory EIP-712 domain probe failed.");

  console.log("SafeCoreFactoryV4 deployment verified.");
  console.log(`SAFECORE_FACTORY_ADDRESS=${address}`);
  console.log(`Block: ${receipt.blockNumber}`);
  console.log(`Bytecode bytes: ${deployedBytes}`);
  console.log(`EIP712 domain hash: ${domainHash}`);
  console.log("Next: verify source, deploy/configure the HTTPS relayer, then place only the PUBLIC factory address in app deployment config.");
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
