#!/usr/bin/env node
import { createHash, createSign, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const ONE_ETHER = 1_000_000_000_000_000_000n;
const DEFAULT_RESPONSE_WINDOW_SECONDS = 24 * 60 * 60;

function sha256Hex(value) {
  return "0x" + createHash("sha256").update(String(value)).digest("hex");
}

function stableHash(value) {
  return sha256Hex(JSON.stringify(value));
}

function makePayerWallet(label) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  const address = "0x" + createHash("sha256").update(publicPem).digest("hex").slice(-40);

  return {
    label,
    address,
    publicPem,
    privateKey,
    sign(payload) {
      const signer = createSign("SHA256");
      signer.update(payload);
      signer.end();
      return "0x" + signer.sign(privateKey).toString("hex");
    },
    verify(payload, signature) {
      const verifier = createVerify("SHA256");
      verifier.update(payload);
      verifier.end();
      return verifier.verify(publicKey, Buffer.from(signature.slice(2), "hex"));
    },
  };
}

function emptyStats() {
  return {
    matchesCreated: 0,
    matchesJoined: 0,
    matchesFinalized: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    timeoutClaimsMade: 0,
    timeoutClaimsReceived: 0,
    timeoutResponses: 0,
    timeoutForfeits: 0,
    totalStakePlayed: 0n,
    lastActiveAt: 0,
  };
}

class LocalArena {
  constructor({ chainId = 31337, contractAddress = "0x" + "cf".repeat(20) } = {}) {
    this.chainId = chainId;
    this.contractAddress = contractAddress;
    this.nextChallengeId = 1;
    this.now = 1_800_000_000;
    this.challenges = new Map();
    this.stats = new Map();
    this.balances = new Map();
    this.events = [];
  }

  statsFor(address) {
    if (!this.stats.has(address)) this.stats.set(address, emptyStats());
    return this.stats.get(address);
  }

  setBalance(address, amount) {
    this.balances.set(address, amount);
  }

  balanceOf(address) {
    return this.balances.get(address) ?? 0n;
  }

  transfer(from, to, amount) {
    if (from) {
      const fromBalance = this.balanceOf(from);
      if (fromBalance < amount) throw new Error(`insufficient balance for ${from}`);
      this.balances.set(from, fromBalance - amount);
    }
    this.balances.set(to, this.balanceOf(to) + amount);
  }

  emit(name, data) {
    this.events.push({ name, at: this.now, ...data });
  }

  advance(seconds) {
    this.now += seconds;
  }

  challenge({ from, stake, rulesHash, p1SessionKeyHash, responseWindowSeconds = DEFAULT_RESPONSE_WINDOW_SECONDS }) {
    if (stake <= 0n) throw new Error("stake required");
    if (!rulesHash || rulesHash === "0x00") throw new Error("rulesHash required");
    if (!p1SessionKeyHash || p1SessionKeyHash === "0x00") throw new Error("p1SessionKeyHash required");

    this.transfer(from.address, nullAddress, stake);
    const challengeId = this.nextChallengeId++;
    const matchContextHash = stableHash({
      chainId: this.chainId,
      contract: this.contractAddress,
      challengeId,
      p1: from.address,
      stake: stake.toString(),
      rulesHash,
      p1SessionKeyHash,
      responseWindowSeconds,
    });

    const challenge = {
      id: challengeId,
      p1: from,
      p2: null,
      stake,
      createdAt: this.now,
      joinedAt: 0,
      responseWindowSeconds,
      rulesHash,
      matchContextHash,
      p1SessionKeyHash,
      p2SessionKeyHash: "0x00",
      latestTranscriptHead: "0x00",
      status: "Open",
      timeout: null,
    };
    this.challenges.set(challengeId, challenge);

    const stats = this.statsFor(from.address);
    stats.matchesCreated += 1;
    stats.lastActiveAt = this.now;

    this.emit("ChallengeCreated", { challengeId, challenger: from.address, stake: stake.toString(), rulesHash, matchContextHash });
    return challengeId;
  }

  join({ challengeId, from, stake, p2SessionKeyHash }) {
    const c = this.getChallenge(challengeId);
    if (c.status !== "Open") throw new Error("not open");
    if (from.address === c.p1.address) throw new Error("cannot join self");
    if (stake !== c.stake) throw new Error("stake mismatch");
    if (!p2SessionKeyHash || p2SessionKeyHash === "0x00") throw new Error("p2SessionKeyHash required");

    this.transfer(from.address, nullAddress, stake);
    c.p2 = from;
    c.joinedAt = this.now;
    c.p2SessionKeyHash = p2SessionKeyHash;
    c.status = "Active";
    c.matchContextHash = stableHash({ previous: c.matchContextHash, p2: from.address, p2SessionKeyHash });

    const p1Stats = this.statsFor(c.p1.address);
    const p2Stats = this.statsFor(from.address);
    p1Stats.totalStakePlayed += c.stake;
    p2Stats.matchesJoined += 1;
    p2Stats.totalStakePlayed += stake;
    p1Stats.lastActiveAt = this.now;
    p2Stats.lastActiveAt = this.now;

    this.emit("ChallengeJoined", { challengeId, joiner: from.address, p2SessionKeyHash });
  }

  finalResultDigest(challengeId, outcome, finalFrame, finalFrameHash, finalStateHash, transcriptHead) {
    const c = this.getChallenge(challengeId);
    return stableHash({
      domain: "CryptoFighter.finalResult.v1",
      chainId: this.chainId,
      contract: this.contractAddress,
      challengeId,
      matchContextHash: c.matchContextHash,
      outcome,
      finalFrame,
      finalFrameHash,
      finalStateHash,
      transcriptHead,
    });
  }

  submitFinalResult({ challengeId, submitter, outcome, finalFrame, finalFrameHash, finalStateHash, transcriptHead, p1Sig, p2Sig }) {
    const c = this.getChallenge(challengeId);
    if (c.status !== "Active") throw new Error("not active");
    if (submitter.address !== c.p1.address && submitter.address !== c.p2.address) throw new Error("not participant");
    if (!p1Sig || !p2Sig) throw new Error("both final signatures required");

    const digest = this.finalResultDigest(challengeId, outcome, finalFrame, finalFrameHash, finalStateHash, transcriptHead);
    if (!c.p1.verify(digest, p1Sig)) throw new Error("bad P1 final signature");
    if (!c.p2.verify(digest, p2Sig)) throw new Error("bad P2 final signature");

    c.latestTranscriptHead = transcriptHead;
    this.emit("FinalResultSubmitted", { challengeId, submitter: submitter.address, outcome, finalFrame, finalFrameHash, finalStateHash, transcriptHead });
    this.finalize(challengeId, outcome);
  }

  claimTimeout({ challengeId, claimant, frame, transcriptHead, packetHash }) {
    const c = this.getChallenge(challengeId);
    if (c.status !== "Active") throw new Error("not active");
    if (claimant.address !== c.p1.address && claimant.address !== c.p2.address) throw new Error("not participant");
    if (c.timeout) throw new Error("timeout already active");
    if (frame <= 0) throw new Error("frame required");

    const accused = claimant.address === c.p1.address ? c.p2 : c.p1;
    c.timeout = {
      claimant,
      accused,
      frame,
      transcriptHead,
      packetHash,
      deadline: this.now + c.responseWindowSeconds,
    };
    c.latestTranscriptHead = transcriptHead;

    this.statsFor(claimant.address).timeoutClaimsMade += 1;
    this.statsFor(accused.address).timeoutClaimsReceived += 1;
    this.statsFor(claimant.address).lastActiveAt = this.now;

    this.emit("TimeoutClaimed", { challengeId, claimant: claimant.address, accused: accused.address, frame, transcriptHead, packetHash, deadline: c.timeout.deadline });
  }

  respondTimeout({ challengeId, responder, frame, transcriptHead, packetHash }) {
    const c = this.getChallenge(challengeId);
    if (c.status !== "Active") throw new Error("not active");
    if (!c.timeout) throw new Error("no active timeout");
    if (responder.address !== c.timeout.accused.address) throw new Error("only accused");
    if (this.now > c.timeout.deadline) throw new Error("deadline passed");
    if (frame < c.timeout.frame) throw new Error("frame regressed");

    c.latestTranscriptHead = transcriptHead;
    c.timeout = null;
    this.statsFor(responder.address).timeoutResponses += 1;
    this.statsFor(responder.address).lastActiveAt = this.now;

    this.emit("TimeoutResponded", { challengeId, responder: responder.address, frame, transcriptHead, packetHash });
  }

  forfeitTimeout({ challengeId }) {
    const c = this.getChallenge(challengeId);
    if (c.status !== "Active") throw new Error("not active");
    if (!c.timeout) throw new Error("no active timeout");
    if (this.now <= c.timeout.deadline) throw new Error("deadline not passed");

    const forfeiter = c.timeout.accused;
    const beneficiary = c.timeout.claimant;
    this.statsFor(forfeiter.address).timeoutForfeits += 1;
    this.emit("TimeoutForfeited", { challengeId, forfeiter: forfeiter.address, beneficiary: beneficiary.address, frame: c.timeout.frame });
    this.finalize(challengeId, beneficiary.address === c.p1.address ? "P1" : "P2");
  }

  finalize(challengeId, outcome) {
    const c = this.getChallenge(challengeId);
    if (c.status !== "Active") throw new Error("not active");
    c.status = "Finalized";

    const pot = c.stake * 2n;
    const p1Stats = this.statsFor(c.p1.address);
    const p2Stats = this.statsFor(c.p2.address);
    p1Stats.matchesFinalized += 1;
    p2Stats.matchesFinalized += 1;
    p1Stats.lastActiveAt = this.now;
    p2Stats.lastActiveAt = this.now;

    let winner = null;
    if (outcome === "P1") {
      winner = c.p1;
      p1Stats.wins += 1;
      p2Stats.losses += 1;
      this.transfer(nullAddress, c.p1.address, pot);
    } else if (outcome === "P2") {
      winner = c.p2;
      p2Stats.wins += 1;
      p1Stats.losses += 1;
      this.transfer(nullAddress, c.p2.address, pot);
    } else if (outcome === "Tie") {
      p1Stats.ties += 1;
      p2Stats.ties += 1;
      this.transfer(nullAddress, c.p1.address, pot / 2n);
      this.transfer(nullAddress, c.p2.address, pot - pot / 2n);
    } else {
      throw new Error("bad outcome");
    }

    this.emit("MatchFinalized", { challengeId, outcome, winner: winner?.address ?? null, payout: pot.toString() });
  }

  getChallenge(challengeId) {
    const c = this.challenges.get(challengeId);
    if (!c) throw new Error("unknown challenge");
    return c;
  }
}

const nullAddress = "0x" + "00".repeat(20);

function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const transcriptFile = process.argv[2] ?? "crypto-fighter-self-play-transcript.json";
  const transcript = JSON.parse(await readFile(transcriptFile, "utf8"));

  const p1 = makePayerWallet("payer-p1");
  const p2 = makePayerWallet("payer-p2");
  const arena = new LocalArena();
  arena.setBalance(nullAddress, 0n);
  arena.setBalance(p1.address, 10n * ONE_ETHER);
  arena.setBalance(p2.address, 10n * ONE_ETHER);

  const stake = ONE_ETHER;
  const rulesHash = stableHash(transcript.rules);
  const p1SessionKeyHash = sha256Hex(transcript.players.p1.publicKey);
  const p2SessionKeyHash = sha256Hex(transcript.players.p2.publicKey);

  const challengeId = arena.challenge({ from: p1, stake, rulesHash, p1SessionKeyHash });
  arena.join({ challengeId, from: p2, stake, p2SessionKeyHash });

  const finalFrame = transcript.final.frame;
  const finalFrameHash = transcript.final.frameHash;
  const finalStateHash = transcript.final.stateHash;
  const transcriptHead = stableHash({
    matchId: transcript.matchId,
    frame: finalFrame,
    frameHash: finalFrameHash,
    stateHash: finalStateHash,
    packetCount: transcript.packets.length,
  });
  const outcome = transcript.final.winner === "P1" ? "P1" : transcript.final.winner === "P2" ? "P2" : "Tie";
  const digest = arena.finalResultDigest(challengeId, outcome, finalFrame, finalFrameHash, finalStateHash, transcriptHead);

  arena.submitFinalResult({
    challengeId,
    submitter: p1,
    outcome,
    finalFrame,
    finalFrameHash,
    finalStateHash,
    transcriptHead,
    p1Sig: p1.sign(digest),
    p2Sig: p2.sign(digest),
  });

  assert(arena.getChallenge(challengeId).status === "Finalized", "happy path should finalize");
  assert(arena.statsFor(p1.address).wins === 1 || arena.statsFor(p2.address).wins === 1 || arena.statsFor(p1.address).ties === 1, "stats should record result");

  const timeoutArena = new LocalArena();
  timeoutArena.setBalance(nullAddress, 0n);
  timeoutArena.setBalance(p1.address, 10n * ONE_ETHER);
  timeoutArena.setBalance(p2.address, 10n * ONE_ETHER);

  const timeoutChallengeId = timeoutArena.challenge({ from: p1, stake, rulesHash, p1SessionKeyHash, responseWindowSeconds: 86_400 });
  timeoutArena.join({ challengeId: timeoutChallengeId, from: p2, stake, p2SessionKeyHash });
  timeoutArena.claimTimeout({
    challengeId: timeoutChallengeId,
    claimant: p1,
    frame: 42,
    transcriptHead: stableHash({ frame: 42, side: "p1-ready" }),
    packetHash: transcript.packets.find((p) => p.player === 1)?.hash ?? randomBytes(32).toString("hex"),
  });
  timeoutArena.respondTimeout({
    challengeId: timeoutChallengeId,
    responder: p2,
    frame: 42,
    transcriptHead: stableHash({ frame: 42, side: "p2-continued" }),
    packetHash: transcript.packets.find((p) => p.player === 2)?.hash ?? randomBytes(32).toString("hex"),
  });
  assert(timeoutArena.getChallenge(timeoutChallengeId).timeout === null, "timeout response should clear timeout");

  const forfeitArena = new LocalArena();
  forfeitArena.setBalance(nullAddress, 0n);
  forfeitArena.setBalance(p1.address, 10n * ONE_ETHER);
  forfeitArena.setBalance(p2.address, 10n * ONE_ETHER);

  const forfeitChallengeId = forfeitArena.challenge({ from: p1, stake, rulesHash, p1SessionKeyHash, responseWindowSeconds: 86_400 });
  forfeitArena.join({ challengeId: forfeitChallengeId, from: p2, stake, p2SessionKeyHash });
  forfeitArena.claimTimeout({
    challengeId: forfeitChallengeId,
    claimant: p1,
    frame: 99,
    transcriptHead: stableHash({ frame: 99, side: "p1-ready" }),
    packetHash: transcript.packets.find((p) => p.player === 1)?.hash ?? randomBytes(32).toString("hex"),
  });
  forfeitArena.advance(86_401);
  forfeitArena.forfeitTimeout({ challengeId: forfeitChallengeId });
  assert(forfeitArena.getChallenge(forfeitChallengeId).status === "Finalized", "timeout forfeit should finalize");
  assert(forfeitArena.statsFor(p2.address).timeoutForfeits === 1, "P2 should record timeout forfeit");

  const report = {
    payerWallets: [
      { label: p1.label, address: p1.address },
      { label: p2.label, address: p2.address },
    ],
    happyPath: {
      challengeId,
      outcome,
      finalFrame,
      transcriptHead,
      p1Balance: arena.balanceOf(p1.address).toString(),
      p2Balance: arena.balanceOf(p2.address).toString(),
      events: arena.events.map((e) => e.name),
      p1Stats: arena.statsFor(p1.address),
      p2Stats: arena.statsFor(p2.address),
    },
    timeoutResponded: {
      challengeId: timeoutChallengeId,
      events: timeoutArena.events.map((e) => e.name),
      p1Stats: timeoutArena.statsFor(p1.address),
      p2Stats: timeoutArena.statsFor(p2.address),
    },
    timeoutForfeit: {
      challengeId: forfeitChallengeId,
      events: forfeitArena.events.map((e) => e.name),
      p1Stats: forfeitArena.statsFor(p1.address),
      p2Stats: forfeitArena.statsFor(p2.address),
    },
  };

  console.log(JSON.stringify(report, bigintReplacer, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
