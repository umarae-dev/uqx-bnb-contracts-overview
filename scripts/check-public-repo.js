const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const forbiddenNames = new Set([
  ".env",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
  "service-account.json",
  "secrets.json",
]);
const skipDirs = new Set([".git", "node_modules", "artifacts", "cache", "coverage", "typechain-types"]);
const textExts = new Set([".js", ".cjs", ".mjs", ".sol", ".md", ".json", ".yml", ".yaml", ".txt", ".env", ""]);
const patterns = [
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub PAT", /\bghp_[A-Za-z0-9]{30,}\b/],
  ["likely secret assignment", /(?:^|\n)\s*(?:API_KEY|SECRET_KEY|PRIVATE_KEY|DATABASE_URL|DB_PASSWORD|JWT_SECRET|PAYMASTER_DEPLOYER_PRIVATE_KEY|UQX_TESTNET_DEPLOYER_PRIVATE_KEY)\s*=\s*(?!\s*(?:$|YOUR_|CHANGE_ME|example|placeholder))([^\s#]{12,})/im],
];

const failures = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (forbiddenNames.has(entry.name)) {
      failures.push(`forbidden sensitive filename: ${rel}`);
      continue;
    }
    if (!textExts.has(path.extname(entry.name).toLowerCase())) continue;
    let text;
    try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
    for (const [label, regex] of patterns) {
      if (regex.test(text)) failures.push(`possible ${label}: ${rel}`);
    }
  }
}

walk(root);
if (failures.length) {
  console.error("Public repository guard failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Public repository guard passed: no forbidden files or obvious credential material found.");
