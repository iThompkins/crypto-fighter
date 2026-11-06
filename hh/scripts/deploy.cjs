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
  await coin.beginGameplayAuthorityTransfer(await vault.getAddress());
  await vault.acceptGameplayAuthority();
  const TokenEscrow = await ethers.getContractFactory("CryptoFighterTokenEscrow");
  const tokenEscrow = await TokenEscrow.deploy(deployer.address, deployer.address);
  await tokenEscrow.waitForDeployment();
  const Ranked = await ethers.getContractFactory("CryptoFighterRanked");
  const ranked = await Ranked.deploy(deployer.address, deployer.address);
  await ranked.waitForDeployment();
  const Arena = await ethers.getContractFactory("CryptoFighterArena");
  const arena = await Arena.deploy(await vault.getAddress(), await tokenEscrow.getAddress(), await ranked.getAddress());
  await arena.waitForDeployment();
  await vault.beginOperatorTransfer(await arena.getAddress());
  await tokenEscrow.beginOperatorTransfer(await arena.getAddress());
  await ranked.beginOperatorTransfer(await arena.getAddress());
  await arena.acceptOperatorRoles();
  console.log("CFC_ADDRESS=" + await coin.getAddress());
  console.log("CFC_OWNER=" + await coin.owner());
  console.log("CFC_GAMEPLAY_AUTHORITY=" + await coin.gameplayAuthority());
  console.log("CFC_VAULT_ADDRESS=" + await vault.getAddress());
  console.log("CFC_VAULT_OWNER=" + await vault.owner());
  console.log("CFC_VAULT_OPERATOR=" + await vault.operator());
  console.log("TOKEN_ESCROW_ADDRESS=" + await tokenEscrow.getAddress());
  console.log("TOKEN_ESCROW_OWNER=" + await tokenEscrow.owner());
  console.log("TOKEN_ESCROW_OPERATOR=" + await tokenEscrow.operator());
  console.log("RANKED_POLICY_ADDRESS=" + await ranked.getAddress());
  console.log("RANKED_POLICY_OWNER=" + await ranked.owner());
  console.log("RANKED_POLICY_OPERATOR=" + await ranked.operator());
  console.log("ARENA_ADDRESS=" + await arena.getAddress());
}

module.exports = { assertLocalDeployment };
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
