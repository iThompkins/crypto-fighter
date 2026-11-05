const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

async function main() {
  assert.equal((await ethers.provider.getNetwork()).chainId, 1n);
  const [deployer] = await ethers.getSigners();
  const Arena = await ethers.getContractFactory("CryptoFighterArena");
  await assert.rejects(Arena.deploy(deployer.address, deployer.address, deployer.address), /prototype: local chain only/);
  const Coin = await ethers.getContractFactory("CryptoFighterCoin");
  await assert.rejects(Coin.deploy(deployer.address), /prototype: local chain only/);
  const Vault = await ethers.getContractFactory("CryptoFighterVault");
  await assert.rejects(
    Vault.deploy(deployer.address, deployer.address, deployer.address),
    /prototype: local chain only/
  );
  const TokenEscrow = await ethers.getContractFactory("CryptoFighterTokenEscrow");
  await assert.rejects(TokenEscrow.deploy(deployer.address, deployer.address), /prototype: local chain only/);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
