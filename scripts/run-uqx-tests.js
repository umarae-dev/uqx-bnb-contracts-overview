"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const testDir = path.join(root, "test", "uqx");

const testFiles = fs
  .readdirSync(testDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => path.posix.join("test", "uqx", entry.name))
  .sort();

if (testFiles.length === 0) {
  console.error("No UQX test files were found under test/uqx.");
  process.exit(1);
}

console.log(`Running ${testFiles.length} UQX/SafeCore test files...`);

const hardhatCli = require.resolve("hardhat/internal/cli/bootstrap.js");
const result = spawnSync(process.execPath, [hardhatCli, "test", ...testFiles], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(result.error.message || result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
