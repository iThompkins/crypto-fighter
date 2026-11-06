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

async function fixture() {
  const [owner, p1, p2, p3, p4, caller] = await ethers.getSigners();
  return { ...(await deployArena([p1, p2, p3, p4])), owner, p1, p2, p3, p4, caller };
}

async function createMatch(m, p1, p2, ranked = true, token = m.coin) {
  const id = await m.arena.nextChallengeId();
  const s1 = ethers.Wallet.createRandom(), s2 = ethers.Wallet.createRandom();
  const matchId = ethers.id(`ranked-${id}-${p1.address}-${p2.address}`);
  await m.arena.connect(p1).challenge(
    matchId, await m.arena.CANONICAL_RULES_HASH(), s1.address, p2.address, await token.getAddress(), ranked
  );
  return { id, s1, s2, matchId, p1, p2 };
}

async function joinAndAuthorize(m, match) {
  await m.arena.connect(match.p2).join(match.id, match.s2.address);
  await m.arena.connect(m.caller).authorizeGenesis(
    match.id,
    match.s1.signingKey.sign(await m.arena.genesisAuthorizationDigest(match.id, 1)).serialized,
    match.s2.signingKey.sign(await m.arena.genesisAuthorizationDigest(match.id, 2)).serialized,
  );
}

async function claim(m, match, outcome) {
  const start = { ...terminalState(0), frame: 0, timer: 300, terminal: false };
  const terminal = terminalState(outcome);
  const points = Array.from({ length: 301 }, (_, index) => checkpoint(ethers.id(`trace-${match.id}-${outcome}-${index}`)));
  points[0] = checkpoint(await m.arena.hashTraceState(start));
  points[300] = checkpoint(await m.arena.hashTraceState(terminal));
  const trace = tree((await m.arena.getChallenge(match.id)).matchContextHash, points);
  await m.arena.connect(match.p1).claimTrace(match.id, trace.root, trace.open(0), trace.open(300), terminal);
  return (await m.arena.getTraceGame(match.id)).deadline;
}

async function finalize(m, match, outcome) {
  const deadline = await claim(m, match, outcome);
  await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline) + 1]);
  await m.arena.connect(m.caller).finalizeTraceClaim(match.id);
}

async function play(m, p1, p2, outcome, ranked = true, token = m.coin) {
  const match = await createMatch(m, p1, p2, ranked, token);
  await joinAndAuthorize(m, match);
  await finalize(m, match, outcome);
  return match;
}

async function buildStreakOnePair(m) {
  await play(m, m.p1, m.p2, 1);
  await play(m, m.p3, m.p4, 1);
  assert.equal(await m.ranked.rankedStreak(m.p1.address), 1n);
  assert.equal(await m.ranked.rankedStreak(m.p3.address), 1n);
}

async function customError(promise, contract, name) {
  await assert.rejects(promise, (error) => {
    assert.equal(contract.interface.parseError(error.data).name, name);
    return true;
  });
}

describe("Ranked CFC streaks and Fibonacci rewards", function () {
  it("advertises standard Fibonacci rewards and rejects the first unrepresentable index", async function () {
    const m = await fixture();
    const expected = [1n, 1n, 2n, 3n, 5n, 8n, 13n, 21n, 34n, 55n, 89n];
    for (let streak = 0; streak < expected.length; streak++) {
      assert.equal(await m.ranked.fibonacciReward(streak), expected[streak] * CFC);
    }
    assert.ok(await m.ranked.fibonacciReward(283) > 0n);
    await customError(m.ranked.fibonacciReward(284), m.ranked, "RewardOverflow");
  });

  it("mints exact successful ranked rewards across the 1, 1, 2 Fibonacci levels", async function () {
    const signers = await ethers.getSigners();
    const players = signers.slice(1, 9);
    const m = { ...(await deployArena(players)), owner: signers[0], caller: signers[9] };
    let contenders = players;
    for (const reward of [1n, 1n, 2n]) {
      const winners = [];
      for (let index = 0; index < contenders.length; index += 2) {
        const p1 = contenders[index], p2 = contenders[index + 1];
        const supplyBefore = await m.coin.totalSupply();
        const match = await play(m, p1, p2, 1);
        assert.equal((await m.arena.getChallenge(match.id)).rewardAmount, reward * CFC);
        assert.equal(await m.coin.totalSupply(), supplyBefore + reward * CFC);
        assert.equal(await m.vault.gameplayRewards(match.matchId), reward * CFC);
        winners.push(p1);
      }
      contenders = winners;
    }
    assert.equal(await m.coin.totalGameplayMinted(), 8n * CFC);
    assert.equal(await m.ranked.rankedStreak(contenders[0].address), 3n);
  });

  it("snapshots equal streaks, exact 1 CFC risk, reward, and policy version", async function () {
    const m = await fixture();
    const match = await createMatch(m, m.p1, m.p2);
    const challenge = await m.arena.getChallenge(match.id);
    const offer = await m.ranked.rankedOffers(match.id);
    assert.equal(challenge.ranked, true);
    assert.equal(challenge.anteAmount, CFC);
    assert.equal(challenge.rewardAmount, CFC);
    assert.equal(offer.startingStreak, 0n);
    assert.equal(offer.policyVersion, 1n);
    assert.equal(await m.coin.totalGameplayMinted(), 0n);
    assert.equal(await m.ranked.activeRankedMatch(m.p1.address), match.id);
    await customError(
      m.arena.connect(m.p1).challenge(
        ethers.id("second-ranked"), await m.arena.CANONICAL_RULES_HASH(),
        ethers.Wallet.createRandom().address, m.p2.address, await m.coin.getAddress(), true
      ),
      m.ranked,
      "PlayerAlreadyRanked",
    );
  });

  it("advances only the winner, resets the loser, blocks an ineligible rematch, and settles once", async function () {
    const m = await fixture();
    await buildStreakOnePair(m);
    const mintedBefore = await m.coin.totalGameplayMinted();
    const decisive = await play(m, m.p1, m.p3, 1);
    assert.equal(await m.ranked.rankedStreak(m.p1.address), 2n);
    assert.equal(await m.ranked.rankedStreak(m.p3.address), 0n);
    assert.equal((await m.ranked.rankedOffers(decisive.id)).rewardAmount, CFC);
    assert.equal(await m.coin.totalGameplayMinted(), mintedBefore + CFC);
    await customError(
      createMatch(m, m.p1, m.p3),
      m.ranked,
      "StaleRankedOffer",
    );
    await assert.rejects(m.arena.finalizeTraceClaim(decisive.id), /trace not finalizable/);
    assert.equal(await m.ranked.rankedStreak(m.p1.address), 2n);
  });

  it("preserves both streaks on a verified draw but resets both on no established result", async function () {
    const draw = await fixture();
    await buildStreakOnePair(draw);
    await play(draw, draw.p1, draw.p3, 3);
    assert.equal(await draw.ranked.rankedStreak(draw.p1.address), 1n);
    assert.equal(await draw.ranked.rankedStreak(draw.p3.address), 1n);

    const expired = await fixture();
    await buildStreakOnePair(expired);
    const match = await createMatch(expired, expired.p1, expired.p3);
    await joinAndAuthorize(expired, match);
    const deadline = (await expired.arena.getChallenge(match.id)).gameDeadline;
    await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline) + 1]);
    await expired.arena.connect(expired.caller).expireUnclaimedMatch(match.id);
    assert.equal(await expired.ranked.rankedStreak(expired.p1.address), 0n);
    assert.equal(await expired.ranked.rankedStreak(expired.p3.address), 0n);
  });

  it("never changes streaks for unranked CFC or approved-token matches", async function () {
    const m = await fixture();
    await buildStreakOnePair(m);
    await play(m, m.p1, m.p3, 1, false);
    assert.equal(await m.ranked.rankedStreak(m.p1.address), 1n);
    assert.equal(await m.ranked.rankedStreak(m.p3.address), 1n);

    const stable = await (await ethers.getContractFactory("CryptoFighterCoin")).deploy(m.owner.address);
    const amount = 1_000_000n;
    await m.tokenEscrow.configureAsset(await stable.getAddress(), amount, true);
    for (const player of [m.p1, m.p3]) {
      await stable.mintAdministrative(player.address, amount);
      await stable.connect(player).approve(await m.tokenEscrow.getAddress(), amount);
    }
    await play(m, m.p1, m.p3, 2, false, stable);
    assert.equal(await m.ranked.rankedStreak(m.p1.address), 1n);
    assert.equal(await m.ranked.rankedStreak(m.p3.address), 1n);
  });

  it("settles concurrent matches into only their own reward credits", async function () {
    const m = await fixture();
    const first = await createMatch(m, m.p1, m.p2, false);
    const second = await createMatch(m, m.p3, m.p4, false);
    await joinAndAuthorize(m, first);
    await joinAndAuthorize(m, second);
    const firstDeadline = await claim(m, first, 1);
    const secondDeadline = await claim(m, second, 2);
    await network.provider.send("evm_setNextBlockTimestamp", [Number(firstDeadline > secondDeadline ? firstDeadline : secondDeadline) + 1]);
    await m.arena.connect(m.caller).finalizeTraceClaim(first.id);
    await m.arena.connect(m.caller).finalizeTraceClaim(second.id);

    assert.equal(await m.vault.gameplayRewards(first.matchId), CFC);
    assert.equal(await m.vault.gameplayRewards(second.matchId), CFC);
    assert.equal(await m.vault.playerCredits(m.p1.address), 2n * CFC);
    assert.equal(await m.vault.playerCredits(m.p4.address), 2n * CFC);
    assert.equal(await m.vault.playerCredits(m.p2.address), 0n);
    assert.equal(await m.vault.playerCredits(m.p3.address), 0n);
    assert.equal(await m.coin.totalGameplayMinted(), 2n * CFC);
  });

  it("rolls back ranked streaks, locks, escrow, and terminal state when minting fails", async function () {
    const m = await fixture();
    const match = await createMatch(m, m.p1, m.p2, true);
    await joinAndAuthorize(m, match);
    const deadline = await claim(m, match, 1);
    await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline) + 1]);
    await m.coin.connect(m.owner).beginGameplayAuthorityTransfer(m.caller.address);
    await m.coin.connect(m.caller).acceptGameplayAuthority();

    await assert.rejects(m.arena.connect(m.caller).finalizeTraceClaim(match.id), /UnauthorizedGameplayAuthority/);
    assert.equal((await m.arena.getChallenge(match.id)).status, 2n);
    assert.equal((await m.ranked.rankedOffers(match.id)).status, 2n);
    assert.equal(await m.ranked.rankedStreak(m.p1.address), 0n);
    assert.equal(await m.ranked.rankedStreak(m.p2.address), 0n);
    assert.equal(await m.ranked.activeRankedMatch(m.p1.address), match.id);
    assert.equal(await m.ranked.activeRankedMatch(m.p2.address), match.id);
    assert.equal(await m.vault.totalActiveEscrow(), 2n * CFC);
    assert.equal(await m.coin.totalGameplayMinted(), 0n);
  });

  it("makes stale offers unjoinable and keeps policy changes future-only", async function () {
    const m = await fixture();
    const stale = await createMatch(m, m.p1, m.p2);
    await play(m, m.p2, m.p3, 1);
    await customError(m.arena.connect(m.p2).join(stale.id, stale.s2.address), m.ranked, "StaleRankedOffer");
    await m.arena.connect(m.p1).cancelOpenChallenge(stale.id);

    const v1 = await createMatch(m, m.p3, m.p4);
    await m.ranked.publishPolicyVersion();
    await joinAndAuthorize(m, v1);
    await finalize(m, v1, 1);
    assert.equal((await m.ranked.rankedOffers(v1.id)).policyVersion, 1n);
    const v2 = await createMatch(m, m.p1, m.p4);
    assert.equal((await m.ranked.rankedOffers(v2.id)).policyVersion, 2n);
  });

  it("releases ranked locks without changing streaks on cancellation or failed activation", async function () {
    const m = await fixture();
    const cancelled = await createMatch(m, m.p1, m.p2);
    await m.arena.connect(m.p1).cancelOpenChallenge(cancelled.id);
    assert.equal(await m.ranked.activeRankedMatch(m.p1.address), 0n);
    assert.equal(await m.ranked.rankedStreak(m.p1.address), 0n);

    const unactivated = await createMatch(m, m.p1, m.p2);
    await m.arena.connect(m.p2).join(unactivated.id, unactivated.s2.address);
    const deadline = await m.arena.genesisAuthorizationDeadline(unactivated.id);
    await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline) + 1]);
    await m.arena.connect(m.caller).refundUnactivatedMatch(unactivated.id);
    assert.equal(await m.ranked.activeRankedMatch(m.p1.address), 0n);
    assert.equal(await m.ranked.activeRankedMatch(m.p2.address), 0n);
    assert.equal(await m.ranked.rankedStreak(m.p1.address), 0n);
    assert.equal(await m.ranked.rankedStreak(m.p2.address), 0n);
    assert.equal(await m.coin.totalGameplayMinted(), 0n);
  });

  it("creates without prefunded rewards and pausing does not block existing exits", async function () {
    const m = await fixture();
    assert.equal(await m.coin.balanceOf(await m.vault.getAddress()), 0n);
    const existing = await createMatch(m, m.p1, m.p2);
    assert.equal(await m.coin.totalGameplayMinted(), 0n);
    await m.ranked.setCreationPaused(true);
    await joinAndAuthorize(m, existing);
    await finalize(m, existing, 1);
    assert.equal(await m.ranked.rankedStreak(m.p1.address), 1n);
    await customError(createMatch(m, m.p3, m.p4), m.ranked, "RankedCreationPaused");
  });
});
