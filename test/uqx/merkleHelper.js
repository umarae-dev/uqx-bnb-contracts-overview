const { ethers } = require("hardhat");

// Minimal, self-contained Merkle tree builder matching the exact scheme
// UqxVesting.sol uses on-chain: a double-keccak leaf (the OpenZeppelin
// second-preimage-safe pattern), and OpenZeppelin's own sorted-pair
// hashing at every level (MerkleProof._hashPair: hash the two children in
// ascending numeric order). No external dependency needed for this.

function hashLeaf(address, amount, allocationType) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint8"],
    [address, amount, allocationType],
  );
  const inner = ethers.keccak256(encoded);
  return ethers.keccak256(inner);
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

/** entries: [{ address, amount (BigInt), allocationType (0|1) }] */
function buildMerkleTree(entries) {
  const leaves = entries.map((e) => hashLeaf(e.address, e.amount, e.allocationType));
  const layers = buildLayers(leaves);
  const root = layers[layers.length - 1][0];
  return {
    root,
    proofFor(entry) {
      const leaf = hashLeaf(entry.address, entry.amount, entry.allocationType);
      return getProof(layers, leaf);
    },
  };
}

module.exports = { buildMerkleTree, hashLeaf };
