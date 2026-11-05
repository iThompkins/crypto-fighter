const { ethers, network } = require("hardhat");

function assertLocalDeployment(networkName, chainId) {
  // Only Hardhat's in-process, ephemeral network. No RPC URL escape hatch.
  if (networkName !== "hardhat" || BigInt(chainId) !== 31337n) {
    throw new Error("Prototype deployment disabled outside the in-process Hardhat network");
  }
}

async function main() {
  assertLocalDeployment(network.name, (await ethers.provider.getNetwork()).chainId);
  const [deployer] = await ethers.getSigners();
  const Coin = await ethers.getContractFactory("CryptoFighterCoin");
  const coin = await Coin.deploy(deployer.address);
  await coin.waitForDeployment();
  const Vault = await ethers.getContractFactory("CryptoFighterVault");
  const vault = await Vault.deploy(await coin.getAddress(), deployer.address, deployer.address);
  await vault.waitForDeployment();
  const Arena = await ethers.getContractFactory("CryptoFighterArena");
  const arena = await Arena.deploy();
  await arena.waitForDeployment();
  console.log("CFC_ADDRESS=" + await coin.getAddress());
  console.log("CFC_OWNER=" + await coin.owner());
  console.log("CFC_VAULT_ADDRESS=" + await vault.getAddress());
  console.log("CFC_VAULT_OWNER=" + await vault.owner());
  console.log("CFC_VAULT_OPERATOR=" + await vault.operator());
  console.log("ARENA_ADDRESS=" + await arena.getAddress());
}

module.exports = { assertLocalDeployment };
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
