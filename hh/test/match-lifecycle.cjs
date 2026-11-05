const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

async function rejected(promise, reason) {
  await assert.rejects(promise, (error) => {
    const decoded = new ethers.Interface(["error Error(string)"]).parseError(error.data);
    assert.equal(decoded.args[0], reason);
    return true;
  });
}

async function deploy() {
  const arena = await (await ethers.getContractFactory("CryptoFighterArena")).deploy();
  await arena.waitForDeployment();
  return arena;
}

describe("CryptoFighterArena match lifecycle", function () {
  it("does not expose removed result or gameplay-timeout APIs", async function () {
    const arena = await deploy();
    const names = new Set(
      arena.interface.fragments
        .filter((fragment) => fragment.type === "function")
        .map((fragment) => fragment.name)
    );
    for (const name of [
      "claimResult", "disputeResult", "finalizeResult",
      "claimTimeout", "respondTimeout", "forfeitTimeout",
    ]) {
      assert.equal(names.has(name), false, `${name} must not remain in the ABI`);
    }
  });

  it("enforces challenge admission and the minimum response window", async function () {
    const [p1, p2] = await ethers.getSigners();
    const arena = await deploy();
    const rules = await arena.CANONICAL_RULES_HASH();
    const session = ethers.Wallet.createRandom();
    const create = (overrides = {}) => arena.connect(p1).challenge(
      overrides.matchId ?? ethers.id("match"),
      overrides.rules ?? rules,
      overrides.session ?? session.address,
      p2.address,
      overrides.window ?? 86400,
      { value: overrides.stake ?? 1n }
    );

    await rejected(create({ stake: 0n }), "stake required");
    await rejected(create({ matchId: ethers.ZeroHash }), "matchId required");
    await rejected(create({ rules: ethers.id("other rules") }), "unsupported canonical rules");
    await rejected(create({ session: ethers.ZeroAddress }), "session key required");
    await rejected(create({ window: 86399 }), "response window too short");

    await (await create()).wait();
    await rejected(create(), "genesis already registered");
    const challenge = await arena.getChallenge(1);
    assert.equal(challenge.status, 1n);
    assert.equal(challenge.stake, 1n);
    assert.equal(challenge.restrictedOpponent, p2.address);
  });

  it("enforces join identity, stake, session-key, and opponent constraints", async function () {
    const [p1, p2, outsider] = await ethers.getSigners();
    const arena = await deploy();
    const s1 = ethers.Wallet.createRandom();
    const s2 = ethers.Wallet.createRandom();
    await (await arena.connect(p1).challenge(
      ethers.id("restricted match"),
      await arena.CANONICAL_RULES_HASH(),
      s1.address,
      p2.address,
      86400,
      { value: 10n }
    )).wait();

    await rejected(arena.connect(p1).join(1, s2.address, { value: 10n }), "cannot join self");
    await rejected(arena.connect(p2).join(1, s2.address, { value: 9n }), "stake mismatch");
    await rejected(arena.connect(p2).join(1, ethers.ZeroAddress, { value: 10n }), "session key required");
    await rejected(arena.connect(p2).join(1, s1.address, { value: 10n }), "distinct session keys required");
    await rejected(arena.connect(outsider).join(1, s2.address, { value: 10n }), "opponent locked");

    await (await arena.connect(p2).join(1, s2.address, { value: 10n })).wait();
    const challenge = await arena.getChallenge(1);
    assert.equal(challenge.status, 2n);
    assert.equal(challenge.p2, p2.address);
    assert.notEqual(challenge.matchContextHash, ethers.ZeroHash);
    await rejected(arena.connect(outsider).join(1, ethers.Wallet.createRandom().address, { value: 10n }), "not open");
  });

  it("lets only the challenger cancel an open match and refunds once", async function () {
    const [p1, other] = await ethers.getSigners();
    const arena = await deploy();
    await (await arena.connect(p1).challenge(
      ethers.id("cancelled match"),
      await arena.CANONICAL_RULES_HASH(),
      ethers.Wallet.createRandom().address,
      ethers.ZeroAddress,
      86400,
      { value: 1000n }
    )).wait();

    await rejected(arena.connect(other).cancelOpenChallenge(1), "only challenger");
    const before = await ethers.provider.getBalance(p1.address);
    const receipt = await (await arena.connect(p1).cancelOpenChallenge(1)).wait();
    const after = await ethers.provider.getBalance(p1.address);
    assert.equal(after - before + receipt.gasUsed * receipt.gasPrice, 1000n);
    assert.equal(await ethers.provider.getBalance(await arena.getAddress()), 0n);
    assert.equal((await arena.getChallenge(1)).status, 3n);
    await rejected(arena.connect(p1).cancelOpenChallenge(1), "not open");
  });
});
