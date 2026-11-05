const { ethers } = require("hardhat");

const CFC = ethers.parseEther("1");

async function deployArena(players = []) {
  const [owner] = await ethers.getSigners();
  const Coin = await ethers.getContractFactory("CryptoFighterCoin");
  const coin = await Coin.deploy(owner.address);
  const Vault = await ethers.getContractFactory("CryptoFighterVault");
  const vault = await Vault.deploy(await coin.getAddress(), owner.address, owner.address);
  const TokenEscrow = await ethers.getContractFactory("CryptoFighterTokenEscrow");
  const tokenEscrow = await TokenEscrow.deploy(owner.address, owner.address);
  const Ranked = await ethers.getContractFactory("CryptoFighterRanked");
  const ranked = await Ranked.deploy(owner.address, owner.address);
  const Arena = await ethers.getContractFactory("CryptoFighterArena");
  const arena = await Arena.deploy(await vault.getAddress(), await tokenEscrow.getAddress(), await ranked.getAddress());

  await vault.beginOperatorTransfer(await arena.getAddress());
  await tokenEscrow.beginOperatorTransfer(await arena.getAddress());
  await ranked.beginOperatorTransfer(await arena.getAddress());
  await arena.acceptOperatorRoles();

  const rewardFunding = ethers.parseEther("1000");
  await coin.mint(owner.address, rewardFunding);
  await coin.approve(await vault.getAddress(), rewardFunding);
  await vault.fundRewards(rewardFunding);
  for (const player of players) await fundCfc({ coin, vault }, player);
  return { owner, coin, vault, tokenEscrow, ranked, arena };
}

async function fundCfc({ coin, vault }, player, amount = ethers.parseEther("100")) {
  const owner = (await ethers.getSigners())[0];
  await coin.connect(owner).mint(player.address, amount);
  await coin.connect(player).approve(await vault.getAddress(), amount);
}

async function createCfcMatch(ctx, { p1, p2, matchId, s1, s2, authorize = true } = {}) {
  const signers = await ethers.getSigners();
  p1 ??= signers[1];
  p2 ??= signers[2];
  matchId ??= ethers.hexlify(ethers.randomBytes(32));
  s1 ??= ethers.Wallet.createRandom();
  s2 ??= ethers.Wallet.createRandom();
  await ctx.arena.connect(p1).challenge(
    matchId, await ctx.arena.CANONICAL_RULES_HASH(), s1.address, p2.address, await ctx.coin.getAddress(), false
  );
  await ctx.arena.connect(p2).join(1, s2.address);
  if (authorize) {
    await ctx.arena.authorizeGenesis(
      1,
      s1.signingKey.sign(await ctx.arena.genesisAuthorizationDigest(1, 1)).serialized,
      s2.signingKey.sign(await ctx.arena.genesisAuthorizationDigest(1, 2)).serialized
    );
  }
  return { ...ctx, p1, p2, matchId, s1, s2 };
}

module.exports = { CFC, deployArena, fundCfc, createCfcMatch };
