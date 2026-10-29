const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { ethers, network } = require("hardhat");
let genesis;
before(async function () {
  await import(pathToFileURL(path.resolve(__dirname, "../../tools/register-types.mjs")).href);
  genesis = await import(pathToFileURL(path.resolve(__dirname, "../../src/genesis.ts")).href);
});

async function rejected(promise, reason) {
  await assert.rejects(promise, (error) => {
    const decoded = new ethers.Interface(["error Error(string)"]).parseError(error.data);
    assert.equal(decoded.args[0], reason);
    return true;
  });
}
async function setup(options = {}) {
  const [p1, p2, relayer] = await ethers.getSigners();
  const arena = await (await ethers.getContractFactory("CryptoFighterArena")).deploy();
  const matchId = options.matchId ?? ethers.hexlify(ethers.randomBytes(32));
  const s1 = options.s1 ?? ethers.Wallet.createRandom(), s2 = options.s2 ?? ethers.Wallet.createRandom();
  const stake = 1000n;
  await (await arena.connect(p1).challenge(matchId, await arena.CANONICAL_RULES_HASH(), s1.address, p2.address, 86400, { value: stake })).wait();
  const joined = await (await arena.connect(p2).join(1, s2.address, { value: stake })).wait();
  const locator = { chainId: "31337", arena: await arena.getAddress(), challengeId: "1" };
  const record = await genesis.readGenesisRecord(ethers.provider, locator, joined.blockNumber);
  const auth = {
    binding: record.binding,
    p1Signature: s1.signingKey.sign(genesis.genesisAuthorizationDigest(record.binding, 1)).serialized,
    p2Signature: s2.signingKey.sign(genesis.genesisAuthorizationDigest(record.binding, 2)).serialized,
  };
  return { arena, p1, p2, relayer, matchId, s1, s2, stake, locator, record, auth };
}
const activate = (m) => m.arena.connect(m.relayer).authorizeGenesis(1, m.auth.p1Signature, m.auth.p2Signature);

describe("Authoritative genesis binding", function () {
  it("builds an evidence-derived trace from the actual activated chain record", async function () {
    const s1 = new ethers.Wallet("0x" + "1".padStart(64, "0"));
    const s2 = new ethers.Wallet("0x" + "2".padStart(64, "0"));
    const m = await setup({ matchId: "0x" + "11".repeat(32), s1, s2 });
    const receipt = await (await activate(m)).wait();
    const record = await genesis.readGenesisRecord(ethers.provider, m.locator, receipt.blockNumber);
    const file = path.join(mkdtempSync(path.join(tmpdir(), "crypto-fighter-chain-trace-")), "terminal.json");
    execFileSync(process.execPath, [path.resolve(__dirname, "../../tools/make-transcript.mjs"), file]);
    const transcript = JSON.parse(readFileSync(file, "utf8"));
    const traceModule = await import(pathToFileURL(path.resolve(__dirname, "../../src/execution-trace.ts")).href);
    const baseline = await traceModule.buildAuthorizedExecutionTrace(transcript, m.auth, record);
    const liveProtocol = await import(pathToFileURL(path.resolve(__dirname, "../../src/live-protocol.ts")).href);
    const evidenceModule = await import(pathToFileURL(path.resolve(__dirname, "../../src/evidence-trace.ts")).href);
    const config = { version: 1, mode: "escrow", matchId: m.matchId, rulesHash: record.binding.rulesHash,
      p1PublicKey: s1.signingKey.publicKey, p2PublicKey: s2.signingKey.publicKey, authorization: m.auth };
    const context = liveProtocol.configHash(config);
    const readiness = [s1, s2].map((key, index) => ({ type: "READY", context, slot: index + 1,
      signature: key.signingKey.sign(liveProtocol.lifecycleDigest(context, index + 1, "READY")).serialized }));
    const archive = { format: "phase-b-journal-v1", journal: [
      { kind: "genesis", config, localSlot: 1, record },
      ...readiness.map(message => ({ kind: "message", message })),
      ...transcript.packets.map(packet => ({ kind: "message", message: { type: "INPUT", context, packet } })),
    ] };
    const bundle = await evidenceModule.buildEvidenceBundle(archive, record);
    const trace = bundle.trace;
    assert.equal(bundle.reconstruction.status, "complete");
    assert.equal(trace.root, baseline.root);
    const defense = await evidenceModule.loadEvidenceDefense(bundle, record);
    const final = bundle.reconstruction.states.at(-1);
    const stateForContract = { frame: final.frame, timer: final.timerFramesLeft, terminal: final.roundOver,
      outcome: { P1: 1, P2: 2, TIE_BOTH_LOSE: 3 }[final.winner], p1: final.p1, p2: final.p2 };
    assert.equal(await m.arena.hashTraceState(stateForContract), trace.terminalStateHash);
    assert.equal(trace.contextHash, (await m.arena.getChallenge(1)).matchContextHash);
    assert.equal(trace.genesisAuthorized, true);
    assert.equal(traceModule.verifyTraceOpening(trace.root, trace.contextHash, traceModule.openTrace(trace, 91)), true);
    assert.equal(trace.settlementEligible, false);
    const verifier = await (await ethers.getContractFactory("TraceCommitmentVerifier")).deploy();
    for (const index of [0, 1, 90, 91, 300]) {
      const opening = defense.opening(index);
      assert.equal(await verifier.hashCheckpoint(opening.checkpoint), traceModule.hashCheckpoint(opening.checkpoint));
      assert.equal(await verifier.verifyOpening(trace.root, trace.contextHash, index, opening.checkpoint, opening.siblings), true);
      assert.equal(await verifier.verifyOpening(trace.root, ethers.id("other binding"), index, opening.checkpoint, opening.siblings), false);
      assert.equal(await verifier.verifyOpening(trace.root, trace.contextHash, index + 1, opening.checkpoint, opening.siblings), false);
      assert.equal(await verifier.verifyOpening(trace.root, trace.contextHash, index, opening.checkpoint, opening.siblings.slice(1)), false);
    }
  });

  it("matches browser hashes and accepts one relayable two-session activation", async function () {
    const m = await setup();
    assert.equal(genesis.hashGenesisBinding(m.record.binding), (await m.arena.getChallenge(1)).matchContextHash);
    for (const slot of [1, 2]) assert.equal(genesis.genesisAuthorizationDigest(m.record.binding, slot), await m.arena.genesisAuthorizationDigest(1, slot));
    assert.equal(genesis.verifyGenesisAuthorization(m.auth, m.record), false);
    const receipt = await (await activate(m)).wait();
    const record = await genesis.readGenesisRecord(ethers.provider, m.locator, receipt.blockNumber);
    assert.equal(record.authorized, true);
    assert.equal(genesis.verifyGenesisAuthorization(m.auth, record), true);
    await rejected(activate(m), "genesis already authorized");
    await assert.rejects(genesis.readGenesisRecord(ethers.provider, { ...m.locator, chainId: "1" }), /unexpected chain/);
  });

  it("rejects a registered genesis even after cancellation", async function () {
    const [p1] = await ethers.getSigners();
    const arena = await (await ethers.getContractFactory("CryptoFighterArena")).deploy();
    const matchId = ethers.hexlify(ethers.randomBytes(32));
    const rulesHash = await arena.CANONICAL_RULES_HASH();
    const open = () => arena.challenge(matchId, rulesHash, p1.address, ethers.ZeroAddress, 86400, { value: 1n });
    await (await open()).wait();
    await rejected(open(), "genesis already registered");
    await (await arena.cancelOpenChallenge(1)).wait();
    await rejected(open(), "genesis already registered");
    assert.equal(await arena.challengeForGenesis(matchId), 1n);
  });

  it("cannot substitute another escrow for the same genesis and keys", async function () {
    const a = await setup();
    const b = await setup({ matchId: a.matchId, s1: a.s1, s2: a.s2 });
    await rejected(b.arena.authorizeGenesis(1, a.auth.p1Signature, a.auth.p2Signature), "bad P1 authorization");
    assert.notEqual(genesis.hashGenesisBinding(a.record.binding), genesis.hashGenesisBinding(b.record.binding));
    assert.equal(genesis.verifyGenesisAuthorization(a.auth, { ...b.record, authorized: true }), false);
  });

  it("rejects changed signed fields, wrong keys, swapped slots and high-S signatures", async function () {
    const m = await setup();
    const changes = {
      chainId: "1", challengeId: "2", genesis: ethers.id("other-genesis"),
      p1: m.relayer.address, stake: "1001", responseWindow: "86401", restrictedOpponent: ethers.ZeroAddress,
    };
    for (const [field, value] of Object.entries(changes)) {
      const altered = { ...m.auth.binding, [field]: value };
      const sig = m.s1.signingKey.sign(genesis.genesisAuthorizationDigest(altered, 1)).serialized;
      await rejected(m.arena.authorizeGenesis(1, sig, m.auth.p2Signature), "bad P1 authorization");
    }
    await rejected(m.arena.authorizeGenesis(1, m.auth.p2Signature, m.auth.p1Signature), "bad P1 authorization");
    const sig = ethers.Signature.from(m.auth.p1Signature);
    const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const high = ethers.concat([sig.r, ethers.toBeHex(order - BigInt(sig.s), 32), ethers.toBeHex(sig.v === 27 ? 28 : 27, 1)]);
    await rejected(m.arena.authorizeGenesis(1, high, m.auth.p2Signature), "noncanonical signature");
    assert.equal(genesis.verifyGenesisAuthorization({ ...m.auth, p1Signature: high }, { ...m.record, authorized: true }), false);
    assert.equal(await m.arena.genesisAuthorized(1), false);
  });

  it("blocks trace facts until authorization and refunds unactivated deposits once", async function () {
    const m = await setup();
    await rejected(m.arena.publishTraceArchive(1, ethers.id("root"), ethers.id("journal")), "genesis not authorized");
    const deadline = await m.arena.genesisAuthorizationDeadline(1);
    await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline)]);
    await rejected(m.arena.refundUnactivatedMatch(1), "authorization window open");
    await rejected(activate(m), "authorization expired");
    const p1Balance = await ethers.provider.getBalance(m.p1.address), p2Balance = await ethers.provider.getBalance(m.p2.address);
    await (await m.arena.connect(m.relayer).refundUnactivatedMatch(1)).wait();
    assert.equal(await ethers.provider.getBalance(m.p1.address), p1Balance + m.stake);
    assert.equal(await ethers.provider.getBalance(m.p2.address), p2Balance + m.stake);
    assert.equal((await m.arena.getGenesisBinding(1)).binding.stake, m.stake);
    assert.equal(await m.arena.challengeForGenesis(m.matchId), 1n);
    await rejected(m.arena.refundUnactivatedMatch(1), "not active");
    await rejected(activate(m), "not active");
  });

  it("allows activation at the inclusive deadline and then prohibits authorization refunds", async function () {
    const m = await setup();
    const deadline = await m.arena.genesisAuthorizationDeadline(1);
    await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline)]);
    await (await activate(m)).wait();
    await rejected(m.arena.refundUnactivatedMatch(1), "genesis already authorized");
  });
});
