const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

async function main() {
  assert.equal((await ethers.provider.getNetwork()).chainId, 1n);
  const Arena = await ethers.getContractFactory("CryptoFighterArena");
  await assert.rejects(Arena.deploy(), /prototype: local chain only/);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
