const { ethers } = require("hardhat");

async function main() {
  const Arena = await ethers.getContractFactory("CryptoFighterArena");
  const arena = await Arena.deploy();
  await arena.waitForDeployment();
  const addr = await arena.getAddress();
  console.log("ARENA_ADDRESS=" + addr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
