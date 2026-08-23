const { ethers } = require("hardhat");

// Same double-keccak leaf + sorted-pair hashing scheme as UqxVesting.sol
// and test/uqx/merkleHelper.js — kept as a small, separate, dependency-free
// copy here so this production script never depends on anything under
// test/.

function hashLeaf(address, amountWei, allocationType) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint8"],
    [address, amountWei, allocationType],
  );
  return ethers.keccak256(ethers.keccak256(encoded));
}

function hashPair(a, b) {
  return a.toLowerCase() < b.toLowerCase()
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

function buildLayers(leaves) {
  let level = leaves.slice();
  const layers = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(hashPair(level[i], level[i + 1]));
      else next.push(level[i]);
    }
    layers.push(next);
    level = next;
  }
  return layers;
}

function getProof(layers, leaf) {
  let index = layers[0].indexOf(leaf);
  if (index === -1) throw new Error("leaf not found in tree");
  const proof = [];
  for (let i = 0; i < layers.length - 1; i++) {
    const level = layers[i];
    const pairIndex = index % 2 === 0 ? index + 1 : index - 1;
    if (pairIndex < level.length) proof.push(level[pairIndex]);
    index = Math.floor(index / 2);
  }
  return proof;
}

/** entries: [{ address, amountWei: string, allocationType: 0|1 }] */
function buildMerkleTree(entries) {
  const leaves = entries.map((e) => hashLeaf(e.address, BigInt(e.amountWei), e.allocationType));
  const layers = buildLayers(leaves);
  return {
    root: layers[layers.length - 1][0],
    proofFor(entry) {
      return getProof(layers, hashLeaf(entry.address, BigInt(entry.amountWei), entry.allocationType));
    },
  };
}

module.exports = { buildMerkleTree, hashLeaf };
