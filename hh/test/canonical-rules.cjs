const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("Canonical gameplay version", function () {
  it("accepts only the canonical fingerprint, not arbitrary match rules", async function () {
    const Arena = await ethers.getContractFactory("CryptoFighterArena");
    const arena = await Arena.deploy();
    const [p1] = await ethers.getSigners();
    const canonical = await arena.CANONICAL_RULES_HASH();
    assert.equal(canonical, "0x1ae89ee81810335d8b8b2ee8d7e9237fef05704a9fae836f3e748fcafdca65cc");
    for (const rules of [ethers.ZeroHash, ethers.id("custom-damage"), ethers.id("custom-physics")]) {
      await assert.rejects(arena.challenge(ethers.randomBytes(32), rules, p1.address, ethers.ZeroAddress, 86400, { value: 1n }), (error) => {
        // viaIR source mapping can omit the reason in Hardhat's message.
        const decoded = arena.interface.parseError(error.data);
        assert.equal(decoded.name, "Error");
        assert.equal(decoded.args[0], "unsupported canonical rules");
        return true;
      });
    }
    await (await arena.challenge(ethers.randomBytes(32), canonical, p1.address, ethers.ZeroAddress, 86400, { value: 1n })).wait();
    assert.equal((await arena.getChallenge(1)).rulesHash, canonical);
  });
});
