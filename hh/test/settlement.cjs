const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");
const { CFC, deployArena } = require("./helpers/arena-fixture.cjs");

const abi = ethers.AbiCoder.defaultAbiCoder();
const tag = (name) => ethers.id(`CryptoFighter:fixed-point-trace-v2:${name}`);
const hash = (types, values) => ethers.keccak256(abi.encode(types, values));
const checkpoint = (stateHash) => ({
  stateHash, frameHead: ethers.ZeroHash, p1Head: ethers.ZeroHash,
  p2Head: ethers.ZeroHash, p1PreviousHead: ethers.ZeroHash, p2PreviousHead: ethers.ZeroHash,
});
const checkpointHash = (value) => hash(Array(7).fill("bytes32"), [tag("checkpoint"), ...Object.values(value)]);
const terminalState = (outcome) => ({
  frame: 300, timer: 0, terminal: true, outcome,
  p1: [30720, 52224, 0, 7, 1, 0, 0], p2: [146432, 52224, 0, 7, -1, 0, 0],
});

function tree(context, checkpoints) {
  const leaves = Array.from({ length: 512 }, (_, index) => index <= 300
    ? hash(["bytes32", "bytes32", "uint256", "bytes32"], [tag("leaf"), context, index, checkpointHash(checkpoints[index])])
    : hash(["bytes32", "bytes32", "uint256"], [tag("padding"), context, index]));
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const previous = levels.at(-1), next = [];
    for (let index = 0; index < previous.length; index += 2) {
      next.push(hash(Array(3).fill("bytes32"), [tag("node"), previous[index], previous[index + 1]]));
    }
    levels.push(next);
  }
  return { root: levels.at(-1)[0], open(index) {
    const siblings = []; let cursor = index;
    for (let depth = 0; depth < 9; depth++) { siblings.push(levels[depth][cursor ^ 1]); cursor >>= 1; }
    return { checkpoint: checkpoints[index], siblings };
  } };
}

async function rejected(promise, reason) {
  await assert.rejects(promise, (error) => {
    const decoded = new ethers.Interface(["error Error(string)"]).parseError(error.data);
    assert.equal(decoded.args[0], reason);
    return true;
  });
}

async function setup(asset = "cfc", options = {}) {
  const [owner, p1, p2, caller] = await ethers.getSigners();
  const ctx = await deployArena([p1, p2]);
  let anteToken = ctx.coin, anteAmount = CFC;
  if (asset === "stable") {
    anteToken = await (await ethers.getContractFactory("CryptoFighterCoin")).deploy(owner.address);
    anteAmount = 1_000_000n;
    await ctx.tokenEscrow.configureAsset(await anteToken.getAddress(), anteAmount, true);
    for (const player of [p1, p2]) {
      await anteToken.mintAdministrative(player.address, anteAmount);
      await anteToken.connect(player).approve(await ctx.tokenEscrow.getAddress(), anteAmount);
    }
  }
  const s1 = ethers.Wallet.createRandom(), s2 = ethers.Wallet.createRandom();
  const matchId = ethers.hexlify(ethers.randomBytes(32));
  await ctx.arena.connect(p1).challenge(
    matchId, await ctx.arena.CANONICAL_RULES_HASH(), s1.address, p2.address, await anteToken.getAddress(), false
  );
  if (options.disableBeforeJoin) {
    await ctx.tokenEscrow.configureAsset(await anteToken.getAddress(), 0, false);
  }
  await ctx.arena.connect(p2).join(1, s2.address);
  await ctx.arena.connect(caller).authorizeGenesis(
    1,
    s1.signingKey.sign(await ctx.arena.genesisAuthorizationDigest(1, 1)).serialized,
    s2.signingKey.sign(await ctx.arena.genesisAuthorizationDigest(1, 2)).serialized
  );
  return { ...ctx, owner, p1, p2, caller, s1, s2, matchId, anteToken, anteAmount };
}

async function traceFor(m, outcome, label = "claim") {
  const start = { ...terminalState(0), frame: 0, timer: 300, terminal: false };
  const terminal = terminalState(outcome);
  const checkpoints = Array.from({ length: 301 }, (_, index) => checkpoint(ethers.id(`${label}-${index}`)));
  checkpoints[0] = checkpoint(await m.arena.hashTraceState(start));
  checkpoints[300] = checkpoint(await m.arena.hashTraceState(terminal));
  return { terminal, ...tree((await m.arena.getChallenge(1)).matchContextHash, checkpoints) };
}

async function finalizeUnchallenged(m, outcome) {
  const trace = await traceFor(m, outcome);
  await m.arena.connect(m.p1).claimTrace(1, trace.root, trace.open(0), trace.open(300), trace.terminal);
  const deadline = (await m.arena.getTraceGame(1)).deadline;
  await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline) + 1]);
  await m.arena.connect(m.caller).finalizeTraceClaim(1);
}

describe("24-hour token settlement", function () {
  it("returns a CFC winner's ante, credits the reward, and forfeits the loser ante once", async function () {
    const m = await setup();
    const supplyBefore = await m.coin.totalSupply();
    await finalizeUnchallenged(m, 1);
    assert.equal((await m.arena.getChallenge(1)).status, 4n);
    assert.equal((await m.arena.getChallenge(1)).result, 1n);
    assert.equal(await m.vault.playerCredits(m.p1.address), 2n * CFC);
    assert.equal(await m.vault.settledTreasury(), CFC);
    assert.equal(await m.vault.totalActiveEscrow(), 0n);
    assert.equal(await m.coin.totalSupply(), supplyBefore + CFC);
    assert.equal(await m.coin.totalGameplayMinted(), CFC);
    assert.equal(await m.coin.gameplayRewardIssued(m.matchId), true);
    assert.equal(await m.vault.gameplayRewards(m.matchId), CFC);
    await rejected(m.arena.finalizeTraceClaim(1), "trace not finalizable");
    const before = await m.coin.balanceOf(m.p1.address);
    await m.vault.connect(m.p1).withdrawCredit(m.p1.address, 2n * CFC);
    assert.equal(await m.coin.balanceOf(m.p1.address), before + 2n * CFC);
  });

  it("settles an approved stablecoin from snapshotted terms after the owner disables it", async function () {
    const m = await setup("stable", { disableBeforeJoin: true });
    const supplyBefore = await m.coin.totalSupply();
    await finalizeUnchallenged(m, 2);
    const token = await m.anteToken.getAddress();
    assert.equal(await m.tokenEscrow.playerCredits(token, m.p2.address), m.anteAmount);
    assert.equal(await m.tokenEscrow.settledTreasury(token), m.anteAmount);
    assert.equal(await m.tokenEscrow.totalActiveEscrow(token), 0n);
    assert.equal(await m.vault.playerCredits(m.p2.address), CFC);
    assert.equal(await m.coin.totalSupply(), supplyBefore + CFC);
  });

  it("sends both draw antes to treasury and mints no gameplay reward", async function () {
    const m = await setup();
    const supplyBefore = await m.coin.totalSupply();
    await finalizeUnchallenged(m, 3);
    assert.equal((await m.arena.getChallenge(1)).result, 3n);
    assert.equal(await m.vault.settledTreasury(), 2n * CFC);
    assert.equal(await m.vault.playerCredits(m.p1.address), 0n);
    assert.equal(await m.vault.playerCredits(m.p2.address), 0n);
    assert.equal(await m.coin.totalSupply(), supplyBefore);
    assert.equal(await m.coin.totalGameplayMinted(), 0n);
  });

  it("keeps the game deadline inclusive, then permits anyone to execute no-proof settlement", async function () {
    const m = await setup();
    const supplyBefore = await m.coin.totalSupply();
    const deadline = (await m.arena.getChallenge(1)).gameDeadline;
    await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline)]);
    await rejected(m.arena.connect(m.caller).expireUnclaimedMatch(1), "game window open");
    await m.arena.connect(m.caller).expireUnclaimedMatch(1);
    assert.equal((await m.arena.getChallenge(1)).result, 4n);
    assert.equal(await m.vault.settledTreasury(), 2n * CFC);
    assert.equal(await m.coin.totalSupply(), supplyBefore);
    assert.equal(await m.coin.totalGameplayMinted(), 0n);
    await rejected(m.arena.expireUnclaimedMatch(1), "not active");
  });

  it("accepts the sole valid midpoint responder after timeout without letting invalid actions extend the clock", async function () {
    const m = await setup();
    const claimant = await traceFor(m, 1, "claimant");
    const challenger = await traceFor(m, 2, "challenger");
    await m.arena.connect(m.p1).claimTrace(1, claimant.root, claimant.open(0), claimant.open(300), claimant.terminal);
    const claimDeadline = (await m.arena.getTraceGame(1)).deadline;
    const malformed = { ...challenger.open(0), siblings: challenger.open(0).siblings.slice(1) };
    await rejected(
      m.arena.connect(m.p2).challengeTrace(1, challenger.root, malformed, challenger.open(300), challenger.terminal),
      "invalid trace opening"
    );
    assert.equal(await m.coin.totalGameplayMinted(), 0n);
    assert.equal((await m.arena.getTraceGame(1)).deadline, claimDeadline);
    await m.arena.connect(m.p2).challengeTrace(1, challenger.root, challenger.open(0), challenger.open(300), challenger.terminal);
    assert.equal(await m.coin.totalGameplayMinted(), 0n);
    const midpointDeadline = (await m.arena.getTraceGame(1)).deadline;
    await m.arena.connect(m.p1).revealMidpoint(1, 0, claimant.open(150));
    assert.equal((await m.arena.getTraceGame(1)).deadline, midpointDeadline);
    await network.provider.send("evm_setNextBlockTimestamp", [Number(midpointDeadline) + 1]);
    await m.arena.connect(m.caller).expireTraceTurn(1);
    assert.equal((await m.arena.getChallenge(1)).result, 1n);
    assert.equal(await m.coin.totalGameplayMinted(), CFC);
  });

  it("settles no result when neither participant answers a bisection turn", async function () {
    const m = await setup();
    const claimant = await traceFor(m, 1, "silent-claimant");
    const challenger = await traceFor(m, 2, "silent-challenger");
    await m.arena.connect(m.p1).claimTrace(1, claimant.root, claimant.open(0), claimant.open(300), claimant.terminal);
    await m.arena.connect(m.p2).challengeTrace(1, challenger.root, challenger.open(0), challenger.open(300), challenger.terminal);
    const deadline = (await m.arena.getTraceGame(1)).deadline;
    await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline) + 1]);
    await m.arena.connect(m.caller).expireTraceTurn(1);
    assert.equal((await m.arena.getChallenge(1)).result, 4n);
    assert.equal(await m.vault.settledTreasury(), 2n * CFC);
    assert.equal(await m.coin.totalGameplayMinted(), 0n);
  });

  it("reverts every settlement state change when gameplay mint authority fails", async function () {
    const m = await setup();
    const trace = await traceFor(m, 1, "mint-failure");
    await m.arena.connect(m.p1).claimTrace(1, trace.root, trace.open(0), trace.open(300), trace.terminal);
    const deadline = (await m.arena.getTraceGame(1)).deadline;
    await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline) + 1]);
    await m.coin.connect(m.owner).beginGameplayAuthorityTransfer(m.caller.address);
    await m.coin.connect(m.caller).acceptGameplayAuthority();

    await assert.rejects(m.arena.connect(m.caller).finalizeTraceClaim(1), /UnauthorizedGameplayAuthority/);
    assert.equal((await m.arena.getChallenge(1)).status, 2n);
    assert.equal((await m.arena.getChallenge(1)).result, 0n);
    assert.equal(await m.vault.totalActiveEscrow(), 2n * CFC);
    assert.equal(await m.vault.totalPlayerCredits(), 0n);
    assert.equal(await m.vault.settledTreasury(), 0n);
    assert.equal(await m.coin.totalGameplayMinted(), 0n);
  });
});
