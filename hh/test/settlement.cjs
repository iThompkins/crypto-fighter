const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("hardhat");

const Outcome = { None: 0, P1: 1, P2: 2, Tie: 3 };
const coder = ethers.AbiCoder.defaultAbiCoder();
const inputMaskFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../test/fixtures/input-mask-v1.json"), "utf8")
);
const validBoundaryMasks = ["0", "15"].map((uintDecimal) =>
  inputMaskFixture.vectors.find(
    (vector) => vector.abiRepresentable && vector.validJsMask && vector.uintDecimal === uintDecimal
  ).uintDecimal
);
const invalidContractMasks = [...new Set(
  inputMaskFixture.vectors
    .filter((vector) => vector.abiRepresentable && !vector.validJsMask)
    .map((vector) => vector.uintDecimal)
)];

function rand32() {
  return ethers.hexlify(ethers.randomBytes(32));
}

function packetDigest(p) {
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "uint256", "uint256", "uint256", "bytes32", "bytes32"],
      [p.matchId, p.frame, p.player, p.inputMask, p.prevSelfHash, p.prevOppHash]
    )
  );
}

// 65-byte (r||s||v) signature by a secp256k1 session wallet over the digest.
function signPacket(wallet, p) {
  const sig = wallet.signingKey.sign(packetDigest(p));
  return ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v, 1)]);
}

function packetTuple(p, signature) {
  return [p.matchId, p.frame, p.player, p.inputMask, p.prevSelfHash, p.prevOppHash, signature];
}

async function deploy() {
  const Arena = await ethers.getContractFactory("CryptoFighterArena");
  const arena = await Arena.deploy();
  await arena.waitForDeployment();
  return arena;
}

async function openMatch(arena, p1, p2, stake, windowSec = 24 * 3600) {
  const matchId = rand32();
  const rulesHash = ethers.id("rules-v1");
  const p1Session = ethers.Wallet.createRandom();
  const p2Session = ethers.Wallet.createRandom();

  const tx = await arena
    .connect(p1)
    .challenge(matchId, rulesHash, p1Session.address, ethers.ZeroAddress, windowSec, { value: stake });
  await tx.wait();
  const challengeId = 1n;
  await (await arena.connect(p2).join(challengeId, p2Session.address, { value: stake })).wait();
  return { matchId, challengeId, p1Session, p2Session };
}

async function openClaimedMatch(p1InputMask = 2, p2InputMask = 1) {
  const [p1, p2, finalizer] = await ethers.getSigners();
  const stake = ethers.parseEther("1");
  const arena = await deploy();
  const { matchId, challengeId, p1Session, p2Session } =
    await openMatch(arena, p1, p2, stake);
  const finalFrame = 10;
  const p1Head = rand32();
  const p2Head = rand32();

  await (await arena
    .connect(p1)
    .claimResult(challengeId, Outcome.P1, finalFrame, rand32(), p1Head, p2Head)).wait();

  const challenge = await arena.getChallenge(challengeId);
  const nextFrame = finalFrame + 1;
  const p1Next = {
    matchId,
    frame: nextFrame,
    player: 1,
    inputMask: p1InputMask,
    prevSelfHash: p1Head,
    prevOppHash: p2Head,
  };
  const p2Next = {
    matchId,
    frame: nextFrame,
    player: 2,
    inputMask: p2InputMask,
    prevSelfHash: p2Head,
    prevOppHash: p1Head,
  };

  return {
    arena,
    challengeId,
    deadline: challenge.resultDeadline,
    finalizer,
    p1,
    p2,
    p1Packet: packetTuple(p1Next, signPacket(p1Session, p1Next)),
    p2Packet: packetTuple(p2Next, signPacket(p2Session, p2Next)),
    stake,
  };
}

async function setNextBlockTimestamp(timestamp) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
}

describe("CryptoFighterArena settlement", function () {
  for (const inputMask of validBoundaryMasks) {
    it(`accepts correctly signed boundary input mask ${inputMask}`, async function () {
      const { arena, challengeId, p1Packet, p2Packet, p2 } =
        await openClaimedMatch(inputMask, inputMask);
      await (await arena.connect(p2).disputeResult(challengeId, p1Packet, p2Packet)).wait();
    });
  }

  for (const inputMask of invalidContractMasks) {
    for (const player of [1, 2]) {
      it(`rejects correctly signed P${player} input mask ${inputMask}`, async function () {
        const p1InputMask = player === 1 ? inputMask : "1";
        const p2InputMask = player === 2 ? inputMask : "2";
        const { arena, challengeId, p1Packet, p2Packet, p2 } =
          await openClaimedMatch(p1InputMask, p2InputMask);
        await assert.rejects(
          arena.connect(p2).disputeResult(challengeId, p1Packet, p2Packet),
          /invalid input mask/
        );
      });
    }
  }

  it("rejects a dispute window shorter than 24 hours", async function () {
    const [p1, p2] = await ethers.getSigners();
    const stake = ethers.parseEther("1");
    const arena = await deploy();
    const matchId = rand32();
    const rulesHash = ethers.id("rules-v1");
    const session = ethers.Wallet.createRandom();

    await assert.rejects(
      arena.connect(p1).challenge(
        matchId,
        rulesHash,
        session.address,
        p2.address,
        24 * 3600 - 1,
        { value: stake }
      ),
      /response window too short/
    );
  });

  it("happy path: claim + finalize pays the pot to the winner", async function () {
    const [p1, p2] = await ethers.getSigners();
    const stake = ethers.parseEther("1");
    const arena = await deploy();
    const { challengeId } = await openMatch(arena, p1, p2, stake, 24 * 3600);

    const finalHead = rand32();
    await (await arena
      .connect(p1)
      .claimResult(challengeId, Outcome.P1, 50, finalHead, rand32(), rand32())).wait();

    // Cannot finalize before the window elapses.
    await assert.rejects(arena.connect(p1).finalizeResult(challengeId), /window open/);

    // Advance past the 24h response window.
    await ethers.provider.send("evm_increaseTime", [24 * 3600 + 1]);
    await ethers.provider.send("evm_mine", []);

    const before = await ethers.provider.getBalance(p1.address);
    const rc = await (await arena.connect(p2).finalizeResult(challengeId)).wait(); // anyone can finalize
    const after = await ethers.provider.getBalance(p1.address);

    // Winner received the full 2x pot (finalized by p2, so no gas paid by p1).
    assert.equal(after - before, stake * 2n, "winner should receive 2x stake");
    assert.equal(await ethers.provider.getBalance(await arena.getAddress()), 0n, "escrow drained");

    const ch = await arena.getChallenge(challengeId);
    assert.equal(ch.status, 3n); // MatchStatus.Finalized (None,Open,Active,Finalized,Cancelled)
    const finalized = rc.logs
      .map((l) => { try { return arena.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "MatchFinalized");
    assert.ok(finalized, "MatchFinalized emitted");
    assert.equal(finalized.args.outcome, BigInt(Outcome.P1));
    assert.equal(finalized.args.winner, p1.address);
  });

  it("at resultDeadline: finalization reverts with window open", async function () {
    const { arena, challengeId, deadline, finalizer } = await openClaimedMatch();

    await setNextBlockTimestamp(deadline);
    await assert.rejects(
      arena.connect(finalizer).finalizeResult(challengeId),
      /window open/
    );

    const block = await ethers.provider.getBlock("latest");
    assert.equal(BigInt(block.timestamp), deadline, "revert mined at exact deadline");
  });

  it("at resultDeadline: a valid opponent dispute succeeds and pays once", async function () {
    const { arena, challengeId, deadline, p1Packet, p2Packet, p2, stake } =
      await openClaimedMatch();
    const before = await ethers.provider.getBalance(p2.address);

    await setNextBlockTimestamp(deadline);
    const rc = await (await arena
      .connect(p2)
      .disputeResult(challengeId, p1Packet, p2Packet)).wait();
    const after = await ethers.provider.getBalance(p2.address);
    const block = await ethers.provider.getBlock(rc.blockNumber);
    const finalized = rc.logs
      .map((l) => { try { return arena.interface.parseLog(l); } catch { return null; } })
      .filter((e) => e && e.name === "MatchFinalized");

    assert.equal(BigInt(block.timestamp), deadline, "dispute mined at exact deadline");
    assert.equal(after - before + rc.gasUsed * rc.gasPrice, stake * 2n, "disputer receives pot once");
    assert.equal(finalized.length, 1, "one MatchFinalized event");
    assert.equal(await ethers.provider.getBalance(await arena.getAddress()), 0n, "escrow drained once");
  });

  it("after resultDeadline: dispute reverts with window closed", async function () {
    const { arena, challengeId, deadline, p1Packet, p2Packet, p2 } =
      await openClaimedMatch();

    await setNextBlockTimestamp(deadline + 1n);
    await assert.rejects(
      arena.connect(p2).disputeResult(challengeId, p1Packet, p2Packet),
      /window closed/
    );

    const block = await ethers.provider.getBlock("latest");
    assert.equal(BigInt(block.timestamp), deadline + 1n, "revert mined immediately after deadline");
  });

  it("after resultDeadline: permissionless finalization succeeds", async function () {
    const { arena, challengeId, deadline, finalizer, p1, stake } = await openClaimedMatch();
    const before = await ethers.provider.getBalance(p1.address);

    await setNextBlockTimestamp(deadline + 1n);
    const rc = await (await arena.connect(finalizer).finalizeResult(challengeId)).wait();
    const after = await ethers.provider.getBalance(p1.address);
    const block = await ethers.provider.getBlock(rc.blockNumber);
    const finalized = rc.logs
      .map((l) => { try { return arena.interface.parseLog(l); } catch { return null; } })
      .filter((e) => e && e.name === "MatchFinalized");

    assert.notEqual(finalizer.address, p1.address, "finalizer is not the winner");
    assert.equal(BigInt(block.timestamp), deadline + 1n, "finalization mined immediately after deadline");
    assert.equal(after - before, stake * 2n, "winner receives the pot");
    assert.equal(finalized.length, 1, "one MatchFinalized event");
  });

  it("dispute: a false claim is trumped by the signed history (auto-loss)", async function () {
    const [p1, p2] = await ethers.getSigners();
    const stake = ethers.parseEther("1");
    const arena = await deploy();
    const { matchId, challengeId, p1Session, p2Session } = await openMatch(arena, p1, p2, stake);

    // P1 falsely claims the match ended at frame 10 with these packet heads.
    const finalFrame = 10;
    const p1Head = rand32();
    const p2Head = rand32();
    await (await arena
      .connect(p1)
      .claimResult(challengeId, Outcome.P1, finalFrame, rand32(), p1Head, p2Head)).wait();

    // P2 trumps it with the real history: both players validly signed frame 11.
    const nextFrame = finalFrame + 1;
    const p1Next = { matchId, frame: nextFrame, player: 1, inputMask: 2, prevSelfHash: p1Head, prevOppHash: p2Head };
    const p2Next = { matchId, frame: nextFrame, player: 2, inputMask: 1, prevSelfHash: p2Head, prevOppHash: p1Head };
    const sig1 = signPacket(p1Session, p1Next);
    const sig2 = signPacket(p2Session, p2Next);

    const before = await ethers.provider.getBalance(p2.address);
    const rc = await (await arena
      .connect(p2)
      .disputeResult(challengeId, packetTuple(p1Next, sig1), packetTuple(p2Next, sig2))).wait();
    const gas = rc.gasUsed * rc.gasPrice;
    const after = await ethers.provider.getBalance(p2.address);

    // Honest disputer wins the pot (net of their gas).
    assert.equal(after - before + gas, stake * 2n, "disputer should net the 2x pot");

    const disputed = rc.logs
      .map((l) => { try { return arena.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "ResultDisputed");
    assert.ok(disputed, "ResultDisputed emitted");
    assert.equal(disputed.args.slashedClaimant, p1.address);

    const stats = await arena.playerStats(p1.address);
    assert.equal(stats.falseResultClaims, 1n, "false claim recorded for reputation");
    const finalized = rc.logs
      .map((l) => { try { return arena.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "MatchFinalized");
    assert.equal(finalized.args.outcome, BigInt(Outcome.P2), "match awarded to honest player");
  });
});
