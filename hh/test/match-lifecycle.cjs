const assert = require("node:assert/strict");
const { ethers } = require("hardhat");
const { CFC, deployArena } = require("./helpers/arena-fixture.cjs");

async function rejected(promise, reason) {
  await assert.rejects(promise, (error) => {
    const decoded = new ethers.Interface(["error Error(string)"]).parseError(error.data);
    assert.equal(decoded.args[0], reason);
    return true;
  });
}

describe("CryptoFighterArena match lifecycle", function () {
  it("does not expose removed legacy result or gameplay-timeout APIs", async function () {
    const { arena } = await deployArena();
    const names = new Set(arena.interface.fragments.filter(f => f.type === "function").map(f => f.name));
    for (const name of ["claimResult", "disputeResult", "finalizeResult", "claimTimeout", "respondTimeout", "forfeitTimeout"]) {
      assert.equal(names.has(name), false, `${name} must not remain in the ABI`);
    }
  });

  it("enforces challenge admission and snapshots the fixed CFC terms", async function () {
    const [p1, p2] = await ethers.getSigners();
    const { arena, coin, vault } = await deployArena([p1]);
    const rules = await arena.CANONICAL_RULES_HASH();
    const cfcAddress = await coin.getAddress();
    const session = ethers.Wallet.createRandom();
    const create = (overrides = {}) => arena.connect(p1).challenge(
      overrides.matchId ?? ethers.id("match"),
      overrides.rules ?? rules,
      overrides.session ?? session.address,
      p2.address,
      cfcAddress
    );

    await rejected(create({ matchId: ethers.ZeroHash }), "matchId required");
    await rejected(create({ rules: ethers.id("other rules") }), "unsupported canonical rules");
    await rejected(create({ session: ethers.ZeroAddress }), "session key required");
    await (await create()).wait();
    await rejected(create(), "genesis already registered");
    const challenge = await arena.getChallenge(1);
    assert.equal(challenge.status, 1n);
    assert.equal(challenge.anteToken, await coin.getAddress());
    assert.equal(challenge.anteAmount, CFC);
    assert.equal(challenge.rewardAmount, CFC);
    assert.equal(challenge.restrictedOpponent, p2.address);
    assert.equal(await vault.totalActiveEscrow(), CFC);
    assert.equal(await vault.totalReservedRewards(), CFC);
  });

  it("enforces join identity, session-key, and opponent constraints", async function () {
    const [p1, p2, outsider] = await ethers.getSigners();
    const { arena, coin, vault } = await deployArena([p1, p2, outsider]);
    const s1 = ethers.Wallet.createRandom();
    const s2 = ethers.Wallet.createRandom();
    await arena.connect(p1).challenge(
      ethers.id("restricted match"), await arena.CANONICAL_RULES_HASH(), s1.address, p2.address, await coin.getAddress()
    );

    await rejected(arena.connect(p1).join(1, s2.address), "cannot join self");
    await rejected(arena.connect(p2).join(1, ethers.ZeroAddress), "session key required");
    await rejected(arena.connect(p2).join(1, s1.address), "distinct session keys required");
    await rejected(arena.connect(outsider).join(1, s2.address), "opponent locked");
    await (await arena.connect(p2).join(1, s2.address)).wait();
    const challenge = await arena.getChallenge(1);
    assert.equal(challenge.status, 2n);
    assert.equal(challenge.p2, p2.address);
    assert.notEqual(challenge.matchContextHash, ethers.ZeroHash);
    assert.equal(await vault.totalActiveEscrow(), 2n * CFC);
    await rejected(arena.connect(outsider).join(1, ethers.Wallet.createRandom().address), "not open");
  });

  it("lets only the challenger cancel and moves the ante to one pull credit", async function () {
    const [p1, other] = await ethers.getSigners();
    const { arena, coin, vault } = await deployArena([p1]);
    await arena.connect(p1).challenge(
      ethers.id("cancelled match"), await arena.CANONICAL_RULES_HASH(),
      ethers.Wallet.createRandom().address, ethers.ZeroAddress, await coin.getAddress()
    );
    await rejected(arena.connect(other).cancelOpenChallenge(1), "only challenger");
    await arena.connect(p1).cancelOpenChallenge(1);
    assert.equal(await vault.playerCredits(p1.address), CFC);
    assert.equal(await vault.totalActiveEscrow(), 0n);
    assert.equal(await vault.totalReservedRewards(), 0n);
    assert.equal((await arena.getChallenge(1)).status, 3n);
    await rejected(arena.connect(p1).cancelOpenChallenge(1), "not open");
  });
});
