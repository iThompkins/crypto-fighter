import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { AbiCoder } from "ethers";
import { buildExecutionTrace, encodeTraceState, hashTraceState, openTrace, verifyTraceOpening, verifyExecutionTraceCommitment, TRACE_DEPTH } from "../src/execution-trace.ts";
import { initialState } from "../src/game.ts";
import { hashPacketFields, signDigest } from "../src/crypto.ts";

const dir = await mkdtemp(join(tmpdir(), "crypto-fighter-trace-"));
const file = join(dir, "terminal.json");
execFileSync(process.execPath, ["tools/make-transcript.mjs", file]);
const transcript = JSON.parse(await readFile(file, "utf8"));
const trace = await buildExecutionTrace(transcript);

test("complete terminal execution produces ordered openings at all 301 state indices", () => {
  assert.equal(trace.terminalFrame, 91);
  assert.equal(trace.checkpoints.length, 301);
  assert.equal(trace.levels[0].length, 512);
  assert.equal(trace.settlementEligible, false);
  for (let index = 0; index <= 300; index++) {
    const opening = openTrace(trace, index);
    assert.equal(opening.siblings.length, TRACE_DEPTH);
    assert.equal(verifyTraceOpening(trace.root, trace.contextHash, opening), true, `index ${index}`);
  }
  assert.deepEqual(trace.checkpoints[91], trace.checkpoints[300]);
  assert.notEqual(trace.levels[0][91], trace.levels[0][300]);
  assert.equal(trace.checkpoints[90].p1Head, trace.checkpoints[91].p1PreviousHead);
  assert.equal(trace.checkpoints[89].p2Head, trace.checkpoints[90].p2PreviousHead);
});

test("proofs reject altered checkpoint, position, branch order, depth, context and root", () => {
  for (const mutate of [
    (p) => { p.checkpoint.stateHash = "0x" + "01".repeat(32); },
    (p) => { p.checkpoint.p1PreviousHead = "0x" + "02".repeat(32); },
    (p) => { p.index++; },
    (p) => { p.index = -1; },
    (p) => { p.index = 301; },
    (p) => { p.index = 0.5; },
    (p) => { p.siblings.reverse(); },
    (p) => { p.siblings.pop(); },
    (p) => { p.siblings.push(p.siblings[0]); },
  ]) {
    const p = openTrace(trace, 90);
    mutate(p);
    assert.equal(verifyTraceOpening(trace.root, trace.contextHash, p), false);
  }
  assert.equal(verifyTraceOpening(trace.root, "0x" + "22".repeat(32), openTrace(trace, 90)), false);
  assert.equal(verifyTraceOpening("0x" + "33".repeat(32), trace.contextHash, openTrace(trace, 90)), false);
  assert.throws(() => openTrace(trace, 301), /invalid trace index/);
  assert.equal(verifyTraceOpening(trace.root, trace.contextHash, null), false);
});

test("canonical state encoding fixes field order and preserves half-units and signed velocity", () => {
  const state = initialState();
  state.p1.x = 120.5;
  state.p1.vy = -22;
  const words = AbiCoder.defaultAbiCoder().decode(
    ["bytes32", "uint256", "uint256", "bool", "uint8", "int256[9]", "int256[9]"], encodeTraceState(state),
  );
  assert.equal(words[5][0], 241n);
  assert.equal(words[5][8], -44n);
  const reordered = { p2: state.p2, p1: state.p1, winner: state.winner, roundOver: state.roundOver, timerFramesLeft: state.timerFramesLeft, frame: state.frame };
  assert.equal(hashTraceState(reordered), hashTraceState(state));
  state.p1.x = 120.25;
  assert.throws(() => hashTraceState(state), /exact safe integers/);
});

test("commitment creation rejects partial, missing, false and post-terminal histories", async () => {
  for (const mutate of [
    (t) => { t.packets.shift(); },
    (t) => { t.final.winner = "P2"; },
    (t) => { delete t.final; },
    (t) => { t.canonicalFrames.pop(); },
    (t) => { t.canonicalFrames.push({ ...t.canonicalFrames.at(-1), frame: 92 }); },
  ]) {
    const t = structuredClone(transcript);
    mutate(t);
    await assert.rejects(buildExecutionTrace(t), /complete terminal transcript required/);
  }
});

test("delayed unexecuted signed inputs cannot change the root", async () => {
  const t = structuredClone(transcript);
  const previous = t.packets.find((p) => p.frame === 91 && p.player === 1);
  const ack = t.packets.find((p) => p.frame === 90 && p.player === 2);
  const p = { ...previous, frame: 92, prevSelfHash: previous.hash, prevOppHash: ack.hash };
  p.hash = hashPacketFields(p.matchId, p.frame, p.player, p.inputMask, p.prevSelfHash, p.prevOppHash);
  p.signature = await signDigest("0x" + "1".padStart(64, "0"), p.hash);
  t.packets.push(p);
  assert.equal((await buildExecutionTrace(t)).root, trace.root);
});

test("generation snapshots its input and CLI emits the same commitment", async () => {
  const t = structuredClone(transcript);
  const pending = buildExecutionTrace(t);
  t.final.winner = "P2";
  assert.equal((await pending).root, trace.root);
  const cli = spawnSync(process.execPath, ["tools/commit-trace.mjs", file, "90"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(cli.stdout);
  assert.equal(report.root, trace.root);
  assert.equal(verifyTraceOpening(report.root, report.contextHash, report.opening), true);
});


test("received commitments must match the rebuilt root and terminal metadata", async () => {
  assert.equal(await verifyExecutionTraceCommitment(transcript, trace), true);
  assert.equal(await verifyExecutionTraceCommitment(transcript, { ...trace, terminalFrame: 90 }), false);
  assert.equal(await verifyExecutionTraceCommitment(transcript, { ...trace, root: "0x" + "99".repeat(32) }), false);
  assert.equal(await verifyExecutionTraceCommitment(transcript, { ...trace, settlementEligible: true }), false);
  assert.equal(await verifyExecutionTraceCommitment(null, trace), false);
  const commitmentFile = join(dir, "commitment.json");
  await writeFile(commitmentFile, JSON.stringify(trace));
  const cli = spawnSync(process.execPath, ["tools/verify-trace.mjs", file, commitmentFile], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), { ok: true, settlementEligible: false });
});
