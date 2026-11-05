const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ethers } = require("hardhat");
const { CFC, deployArena } = require("./helpers/arena-fixture.cjs");

let funded;

before(async function () {
  await import(pathToFileURL(path.resolve(__dirname, "../../tools/register-types.mjs")).href);
  funded = await import(pathToFileURL(path.resolve(__dirname, "../../src/funded-match.ts")).href);
});

async function fixture() {
  const [owner, p1, p2, p3] = await ethers.getSigners();
  const contracts = await deployArena([p1, p2, p3]);
  return { owner, p1, p2, p3, ...contracts };
}

describe("Funded browser match transactions", function () {
  it("rejects non-local funded-match chains before planning a transaction", function () {
    assert.doesNotThrow(() => funded.requireLocalFundedChain(31337n));
    assert.throws(() => funded.requireLocalFundedChain(1n), /local chain 31337/);
  });

  it("previews exact ranked terms, approves one ante, creates, and joins", async function () {
    const m = await fixture();
    const arena = await m.arena.getAddress(), cfc = await m.coin.getAddress(), vault = await m.vault.getAddress();
    await m.coin.connect(m.p1).approve(vault, 0);
    await m.coin.connect(m.p2).approve(vault, 0);

    const plan = await funded.readFundedOfferPlan(ethers.provider, arena, m.p1.address, m.p2.address, undefined, true);
    assert.equal(plan.anteToken, cfc);
    assert.equal(plan.spender, vault);
    assert.equal(plan.anteAmount, CFC.toString());
    assert.equal(plan.anteDisplay, "1.0");
    assert.equal(plan.rewardCfc, "1.0");
    assert.equal(plan.ranked, true);
    assert.equal(plan.allowanceRequired, true);
    assert.equal(plan.rankedPreview.eligible, true);

    const firstSession = ethers.Wallet.createRandom();
    const created = await funded.createFundedOffer(m.p1, {
      arena,
      matchId: ethers.id("funded-client-ranked"),
      sessionKey: firstSession.address,
      opponent: m.p2.address,
      ranked: true,
    });
    assert.equal(created.challengeId, "1");
    assert.ok(created.approvalHash);
    assert.equal(await m.coin.allowance(m.p1.address, vault), 0n);
    const challenge = await m.arena.getChallenge(1);
    assert.equal(challenge.p1SessionKey, firstSession.address);
    assert.equal(challenge.ranked, true);

    const joinPlan = await funded.readFundedJoinPlan(ethers.provider, arena, "1", m.p2.address);
    assert.equal(joinPlan.anteAmount, CFC.toString());
    assert.equal(joinPlan.allowanceRequired, true);
    const secondSession = ethers.Wallet.createRandom();
    const joined = await funded.joinFundedOffer(m.p2, { arena, challengeId: "1", sessionKey: secondSession.address });
    assert.ok(joined.approvalHash);
    assert.equal((await m.arena.getChallenge(1)).p2SessionKey, secondSession.address);
    assert.equal((await m.arena.getChallenge(1)).status, 2n);
    assert.equal(await m.coin.allowance(m.p2.address, vault), 0n);
  });

  it("shows approved-token units and prevents an unintended player from joining", async function () {
    const m = await fixture();
    const stable = await (await ethers.getContractFactory("CryptoFighterCoin")).deploy(m.owner.address);
    const ante = 1_000_000n;
    await m.tokenEscrow.configureAsset(await stable.getAddress(), ante, true);
    await stable.mint(m.p1.address, ante);
    await stable.connect(m.p1).approve(await m.tokenEscrow.getAddress(), 0);
    const arena = await m.arena.getAddress();
    const plan = await funded.readFundedOfferPlan(
      ethers.provider, arena, m.p1.address, m.p2.address, await stable.getAddress(), false,
    );
    assert.equal(plan.anteAmount, ante.toString());
    assert.equal(plan.anteDisplay, "0.000000000001");
    assert.equal(plan.spender, await m.tokenEscrow.getAddress());
    assert.equal(plan.allowanceRequired, true);
    const created = await funded.createFundedOffer(m.p1, {
      arena,
      matchId: ethers.id("funded-client-stable"),
      sessionKey: ethers.Wallet.createRandom().address,
      opponent: m.p2.address,
      anteToken: await stable.getAddress(),
      ranked: false,
    });
    assert.equal(created.challengeId, "1");
    await assert.rejects(
      funded.readFundedJoinPlan(ethers.provider, arena, "1", m.p3.address),
      /restricted to another opponent/,
    );
    await m.tokenEscrow.configureAsset(await stable.getAddress(), 0, false);
    await assert.rejects(
      funded.readFundedOfferPlan(ethers.provider, arena, m.p3.address, "", await stable.getAddress(), false),
    );
  });

  it("does not consume a client session when the arena transaction reverts", async function () {
    const m = await fixture();
    const arena = await m.arena.getAddress(), vault = await m.vault.getAddress();
    await m.coin.connect(m.p1).approve(vault, 0);
    const args = {
      arena,
      matchId: ethers.id("funded-client-retry"),
      opponent: m.p2.address,
      ranked: false,
    };
    await assert.rejects(
      funded.createFundedOffer(m.p1, { ...args, sessionKey: ethers.ZeroAddress }),
      /session key required/,
    );
    assert.equal(await m.arena.nextChallengeId(), 1n);
    const retry = await funded.createFundedOffer(m.p1, {
      ...args,
      sessionKey: ethers.Wallet.createRandom().address,
    });
    assert.equal(retry.challengeId, "1");
  });
});
