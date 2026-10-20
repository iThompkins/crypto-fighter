const { ethers, network } = require("hardhat");

function assertLocalDeployment(networkName, chainId) {
  // Only Hardhat's in-process, ephemeral network. No RPC URL escape hatch.
  if (networkName !== "hardhat" || BigInt(chainId) !== 31337n) {
    throw new Error("Prototype deployment disabled outside the in-process Hardhat network");
  }
}

async function main() {
  assertLocalDeployment(network.name, (await ethers.provider.getNetwork()).chainId);
  const Arena = await ethers.getContractFactory("CryptoFighterArena");
  const arena = await Arena.deploy();
  await arena.waitForDeployment();
  const addr = await arena.getAddress();
  console.log("ARENA_ADDRESS=" + addr);
}

module.exports = { assertLocalDeployment };
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
