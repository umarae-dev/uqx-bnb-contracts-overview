require("dotenv").config({ quiet: true });
const http = require("node:http");
const { ethers } = require("ethers");

const PORT = Number(process.env.PORT || 8787);
const CHAIN_ID = BigInt(process.env.SAFECORE_CHAIN_ID || "56");
const RPC_URL = process.env.SAFECORE_RPC_URL || process.env.BSC_DEPLOY_RPC_URL || "https://bsc-rpc.publicnode.com";
const FACTORY_ADDRESS = (process.env.SAFECORE_FACTORY_ADDRESS || "").trim();
const RELAYER_PRIVATE_KEY = (process.env.SAFECORE_RELAYER_PRIVATE_KEY || "").trim();
const MAX_BODY_BYTES = 64 * 1024;
const ACCOUNT_MAX_GAS = BigInt(process.env.SAFECORE_RELAYER_ACCOUNT_MAX_GAS || process.env.SAFECORE_RELAYER_MAX_GAS || "1200000");
const FACTORY_MAX_GAS = BigInt(process.env.SAFECORE_RELAYER_FACTORY_MAX_GAS || "8000000");
const RATE_LIMIT_PER_MINUTE = Number(process.env.SAFECORE_RELAYER_RATE_LIMIT || "30");
const MAX_PENDING_RELAYS = Number(process.env.SAFECORE_RELAYER_MAX_PENDING || "64");
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.SAFECORE_TRUST_PROXY || "false"));

const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hexPattern = /^0x[0-9a-fA-F]*$/;
const selector = (signature) => ethers.id(signature).slice(0, 10).toLowerCase();
const FACTORY_CREATE_SELECTOR = selector("createAccountFor(address,(address,address,address,bytes32,uint64,address[],uint192[]),uint256,bytes)");
const SWEEP_RETIRED_SELECTOR = selector("sweepRetired(address,address)");
const REBIND_SUCCESSOR_SELECTOR = selector("rebindSuccessorDevice(address,uint256,bytes)");
const RETIRED_SELECTORS = new Set([SWEEP_RETIRED_SELECTOR, REBIND_SUCCESSOR_SELECTOR]);
const ACCOUNT_SELECTORS = new Set([
  selector("requestDeviceEnrollment(address,bytes32,uint256,bytes,bytes)"),
  selector("activateDeviceWithApproval(address,bytes32,address,uint256,bytes)"),
  selector("relaySpend(address,address,address,uint256,uint256,bytes)"),
  selector("emergencyRescue(bytes32,bytes,address,bytes32,address,uint256,bytes)"),
  SWEEP_RETIRED_SELECTOR,
  REBIND_SUCCESSOR_SELECTOR,
  selector("requestEmergencyDestinationsChange(address,address,address,uint256,bytes)"),
  selector("applyEmergencyDestinationsChange()"),
  selector("cancelEmergencyDestinationsChange(address,uint256,bytes)"),
  selector("relayRevokeDevice(address,address,uint256,bytes)"),
  selector("requestBudgetChange(address,address,uint192,uint256,bytes)"),
  selector("applyBudgetIncrease(address)"),
  selector("cancelBudgetIncrease(address,address,uint256,bytes)"),
]);
const IDENTITY_SELECTOR = selector("identity()");
const ACCOUNT_OF_SELECTOR = selector("accountOf(address)");
const FACTORY_ACCOUNT_SELECTOR = selector("isFactoryAccount(address)");
const RECOVERY_COMMITMENT_SELECTOR = selector("recoveryCommitment()");
const SUCCESSOR_CONFIG_SELECTOR = selector("successorConfigHash()");
const coder = ethers.AbiCoder.defaultAbiCoder();

if (!addressPattern.test(FACTORY_ADDRESS)) throw new Error("SAFECORE_FACTORY_ADDRESS must be configured with the deployed V4 factory address.");
if (!/^0x[0-9a-fA-F]{64}$/.test(RELAYER_PRIVATE_KEY)) throw new Error("SAFECORE_RELAYER_PRIVATE_KEY must be supplied through the private runtime environment.");
if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid PORT.");
if (!Number.isFinite(RATE_LIMIT_PER_MINUTE) || RATE_LIMIT_PER_MINUTE < 1 || RATE_LIMIT_PER_MINUTE > 600) throw new Error("Invalid SAFECORE_RELAYER_RATE_LIMIT.");
if (!Number.isSafeInteger(MAX_PENDING_RELAYS) || MAX_PENDING_RELAYS < 1 || MAX_PENDING_RELAYS > 1000) throw new Error("Invalid SAFECORE_RELAYER_MAX_PENDING.");
if (ACCOUNT_MAX_GAS < 100000n || ACCOUNT_MAX_GAS > 5000000n) throw new Error("Invalid SAFECORE_RELAYER_ACCOUNT_MAX_GAS.");
if (FACTORY_MAX_GAS < 1000000n || FACTORY_MAX_GAS > 15000000n) throw new Error("Invalid SAFECORE_RELAYER_FACTORY_MAX_GAS.");

const provider = new ethers.JsonRpcProvider(RPC_URL, Number(CHAIN_ID), { staticNetwork: true });
const wallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);
const factory = ethers.getAddress(FACTORY_ADDRESS);
const rate = new Map();
let relayQueue = Promise.resolve();
let pendingRelays = 0;

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(payload);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (forwarded.length) return forwarded.at(-1);
  }
  return req.socket.remoteAddress || "unknown";
}

function checkRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const windowStart = now - 60_000;
  const recent = (rate.get(ip) || []).filter((t) => t >= windowStart);
  if (recent.length >= RATE_LIMIT_PER_MINUTE) return false;
  recent.push(now);
  rate.set(ip, recent);
  if (rate.size > 10_000) for (const [key, values] of rate) if (!values.some((t) => t >= windowStart)) rate.delete(key);
  return true;
}

async function readJson(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) throw new Error("invalid_content_type");
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) throw new Error("empty_request");
  return JSON.parse(raw);
}

function normalizeRelayRequest(body) {
  const target = String(body?.target || "").trim();
  const data = String(body?.data || "").trim();
  if (!addressPattern.test(target)) throw new Error("invalid_target");
  if (!hexPattern.test(data) || data.length < 10 || data.length > MAX_BODY_BYTES * 2) throw new Error("invalid_calldata");
  return { target: ethers.getAddress(target), data };
}

async function verifyFactory() {
  const network = await provider.getNetwork();
  if (network.chainId !== CHAIN_ID) throw new Error("wrong_chain");
  const code = await provider.getCode(factory);
  if (!code || code === "0x") throw new Error("factory_not_deployed");
}

async function verifyCurrentRegisteredAccount(target) {
  const code = await provider.getCode(target);
  if (!code || code === "0x") throw new Error("target_not_contract");
  const identityRaw = await provider.call({ to: target, data: IDENTITY_SELECTOR });
  if (!identityRaw || identityRaw === "0x") throw new Error("not_safecore_account");
  const [identity] = coder.decode(["address"], identityRaw);
  const accountOfData = ACCOUNT_OF_SELECTOR + ethers.zeroPadValue(identity, 32).slice(2);
  const accountRaw = await provider.call({ to: factory, data: accountOfData });
  const [registered] = coder.decode(["address"], accountRaw);
  if (ethers.getAddress(registered) !== ethers.getAddress(target)) throw new Error("account_not_factory_registered");
}

async function verifyRetiredFactoryAccount(target) {
  const code = await provider.getCode(target);
  if (!code || code === "0x") throw new Error("target_not_contract");
  const registryData = FACTORY_ACCOUNT_SELECTOR + ethers.zeroPadValue(target, 32).slice(2);
  const registryRaw = await provider.call({ to: factory, data: registryData });
  const [registered] = coder.decode(["bool"], registryRaw);
  if (!registered) throw new Error("account_not_factory_registered");
  const [recoveryRaw, successorRaw] = await Promise.all([
    provider.call({ to: target, data: RECOVERY_COMMITMENT_SELECTOR }),
    provider.call({ to: target, data: SUCCESSOR_CONFIG_SELECTOR }),
  ]);
  const [recovery] = coder.decode(["bytes32"], recoveryRaw);
  const [successor] = coder.decode(["bytes32"], successorRaw);
  if (recovery !== ethers.ZeroHash || successor === ethers.ZeroHash) throw new Error("account_not_retired");
}

async function validateTargetAndSelector(target, data) {
  const callSelector = data.slice(0, 10).toLowerCase();
  if (ethers.getAddress(target) === factory) {
    if (callSelector !== FACTORY_CREATE_SELECTOR) throw new Error("factory_selector_not_allowed");
    return { maxGas: FACTORY_MAX_GAS };
  }
  if (!ACCOUNT_SELECTORS.has(callSelector)) throw new Error("account_selector_not_allowed");
  if (RETIRED_SELECTORS.has(callSelector)) await verifyRetiredFactoryAccount(target);
  else await verifyCurrentRegisteredAccount(target);
  return { maxGas: ACCOUNT_MAX_GAS };
}

function withRelayNonceLock(fn) {
  if (pendingRelays >= MAX_PENDING_RELAYS) return Promise.reject(new Error("relayer_overloaded"));
  pendingRelays += 1;
  const wrapped = async () => { try { return await fn(); } finally { pendingRelays -= 1; } };
  const next = relayQueue.then(wrapped, wrapped);
  relayQueue = next.catch(() => undefined);
  return next;
}

async function relay(target, data) {
  return withRelayNonceLock(async () => {
    await verifyFactory();
    const { maxGas } = await validateTargetAndSelector(target, data);
    await provider.call({ from: wallet.address, to: target, data, value: 0n });
    const estimated = await provider.estimateGas({ from: wallet.address, to: target, data, value: 0n });
    if (estimated <= 0n || estimated > maxGas) throw new Error("gas_limit_rejected");
    const gasLimit = (estimated * 120n) / 100n;
    if (gasLimit > maxGas) throw new Error("gas_limit_rejected");
    const [nonce, feeData, balance] = await Promise.all([
      provider.getTransactionCount(wallet.address, "pending"), provider.getFeeData(), provider.getBalance(wallet.address),
    ]);
    const gasPrice = feeData.gasPrice;
    if (!gasPrice || gasPrice <= 0n) throw new Error("gas_price_unavailable");
    if (balance < gasLimit * gasPrice) throw new Error("relayer_insufficient_bnb");
    const signed = await wallet.signTransaction({ chainId: CHAIN_ID, type: 0, nonce, to: target, data, value: 0n, gasLimit, gasPrice });
    return (await provider.broadcastTransaction(signed)).hash;
  });
}

function publicError(error) {
  const code = String(error?.message || error || "relay_failed");
  const known = new Set([
    "request_too_large", "empty_request", "invalid_content_type", "invalid_target", "invalid_calldata", "wrong_chain",
    "factory_not_deployed", "target_not_contract", "not_safecore_account", "account_not_factory_registered", "account_not_retired",
    "factory_selector_not_allowed", "account_selector_not_allowed", "gas_limit_rejected", "gas_price_unavailable",
    "relayer_insufficient_bnb", "relayer_overloaded",
  ]);
  return known.has(code) ? code : "signed_call_rejected";
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      const network = await provider.getNetwork();
      const factoryCode = await provider.getCode(factory);
      return json(res, 200, {
        status: network.chainId === CHAIN_ID && factoryCode !== "0x" ? "ready" : "not_ready",
        chain_id: Number(network.chainId), factory, relayer: wallet.address, protocol: 4, implementation: "4.2",
        account_max_gas: ACCOUNT_MAX_GAS.toString(), factory_max_gas: FACTORY_MAX_GAS.toString(),
      });
    }
    if (req.method === "POST" && req.url === "/relay") {
      if (!checkRateLimit(req)) return json(res, 429, { error: "rate_limited" });
      const { target, data } = normalizeRelayRequest(await readJson(req));
      return json(res, 202, { tx_hash: await relay(target, data), chain_id: Number(CHAIN_ID) });
    }
    return json(res, 404, { error: "not_found" });
  } catch (error) {
    const code = publicError(error);
    const status = code === "request_too_large" ? 413 : code === "relayer_overloaded" ? 503 : 400;
    return json(res, status, { error: code });
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

async function boot() {
  await verifyFactory();
  const balance = await provider.getBalance(wallet.address);
  console.log(`SafeCore V4.2 relayer ready on chain ${CHAIN_ID}.`);
  console.log(`Factory: ${factory}`);
  console.log(`Relayer: ${wallet.address}`);
  console.log(`Relayer balance: ${ethers.formatEther(balance)} BNB`);
  console.log(`Trusted proxy headers: ${TRUST_PROXY ? "enabled" : "disabled"}`);
  console.log(`Gas caps: account=${ACCOUNT_MAX_GAS} factory=${FACTORY_MAX_GAS}`);
  console.log("Calldata and private keys are never logged by this service.");
  server.listen(PORT, "0.0.0.0", () => console.log(`Listening on :${PORT}`));
}

boot().catch((error) => { console.error(`SafeCore relayer startup failed: ${publicError(error)}`); process.exitCode = 1; });
