import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { verifyTranscript } from "../src/verifier.ts";
import { hashJson, hashPacketFields, signDigest, ZERO32 } from "../src/crypto.ts";
import { initialState, transition } from "../src/game.ts";

const dir = await mkdtemp(join(tmpdir(), "crypto-fighter-integrity-"));
const file = join(dir, "terminal.json");
execFileSync(process.execPath, ["tools/make-transcript.mjs", file]);
const terminal = JSON.parse(await readFile(file, "utf8"));

function prefix() {
  const t = structuredClone(terminal);
  t.canonicalFrames = t.canonicalFrames.slice(0, 1);
  t.packets = t.packets.filter((p) => p.frame === 1);
  const state = transition(initialState(), t.packets[0].inputMask, t.packets[1].inputMask);
  t.final = { frame: 1, frameHash: t.canonicalFrames[0].frameHash, stateHash: hashJson(state), p1Hp: state.p1.hp, p2Hp: state.p2.hp, winner: null, roundOver: false };
  return t;
}

for (const [name, mutate] of [
  ["missing final record", (t) => { delete t.final; }],
  ["missing state hash", (t) => { delete t.final.stateHash; }],
  ["empty state hash", (t) => { t.final.stateHash = ""; }],
  ["missing winner", (t) => { delete t.final.winner; }],
  ["missing packets", (t) => { delete t.packets; }],
  ["missing canonical history", (t) => { delete t.canonicalFrames; }],
  ["duplicate canonical frame", (t) => { t.canonicalFrames.splice(1, 0, t.canonicalFrames[0]); }],
  ["canonical gap", (t) => { t.canonicalFrames.splice(5, 1); }],
  ["reordered canonical frames", (t) => { t.canonicalFrames.reverse(); }],
  ["unbounded canonical history", (t) => { t.canonicalFrames = Array(301).fill(t.canonicalFrames[0]); }],
  ["unbounded packet history", (t) => { t.packets = Array(605).fill(t.packets[0]); }],
  ["noninteger packet frame", (t) => { t.packets[0].frame = 1.5; }],
  ["unsafe packet frame", (t) => { t.packets[0].frame = Number.MAX_SAFE_INTEGER; }],
  ["invalid packet slot", (t) => { t.packets[0].player = 3; }],
  ["short match identifier", (t) => { t.matchId = "0x11"; }],
  ["zero match identifier", (t) => { t.matchId = ZERO32; }],
  ["different rules version", (t) => { t.version = 2; }],
  ["altered delay", (t) => { t.rules.inputDelay = 1; }],
  ["altered HP rules", (t) => { t.rules.maxHp = 100; }],
  ["altered round limit", (t) => { t.rules.roundFrames = 1000; }],
  ["extra rule", (t) => { t.rules.gravity = 20; }],
  ["invalid public key", (t) => { t.players.p1.publicKey = "0x04" + "00".repeat(64); }],
  ["missing genesis packet", (t) => { t.packets.shift(); }],
  ["missing interior packet", (t) => { t.packets.splice(20, 1); }],
  ["duplicate packet", (t) => { t.packets.push(t.packets[0]); }],
  ["false final outcome", (t) => { t.final.winner = "P2"; }],
  ["tampered signature", (t) => { t.packets[0].signature = "0x" + "00".repeat(65); }],
  ["post-terminal canonical frame", (t) => { t.canonicalFrames.push({ ...t.canonicalFrames.at(-1), frame: t.final.frame + 1 }); }],
]) {
  test(`rejects ${name}`, async () => {
    const t = structuredClone(terminal);
    mutate(t);
    const result = await verifyTranscript(t);
    assert.equal(result.ok, false, name);
    assert.equal(result.complete, false);
    assert.equal(result.settlementEligible, false);
  });
}

test("malformed top-level values fail without throwing", async () => {
  for (const value of [null, undefined, [], "bad", 1, {}, { packets: {}, canonicalFrames: [] }]) {
    assert.equal((await verifyTranscript(value)).ok, false);
  }
});

test("strict mode rejects a valid truncated prefix; explicit partial replay never authorizes settlement", async () => {
  const t = prefix();
  const strict = await verifyTranscript(t);
  assert.equal(strict.ok, false);
  assert.match(strict.errors.join(" "), /terminal history required/);
  const partial = await verifyTranscript(t, { allowPartial: true });
  assert.equal(partial.ok, true);
  assert.equal(partial.complete, false);
  assert.equal(partial.settlementEligible, false);
  const file = join(dir, "partial.json");
  await writeFile(file, JSON.stringify(t));
  for (const [args, expected] of [[[], 1], [["--allow-partial"], 0]]) {
    const cli = spawnSync(process.execPath, ["tools/verify-match.mjs", file, ...args], { encoding: "utf8" });
    assert.equal(cli.status, expected, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).complete, false);
  }
});

test("valid delayed packets are authenticated but cannot extend terminal execution", async () => {
  const t = structuredClone(terminal);
  const frame = t.final.frame + 1;
  const previous = t.packets.find((p) => p.frame === frame - 1 && p.player === 1);
  const ack = t.packets.find((p) => p.frame === frame - 2 && p.player === 2);
  const p = { ...previous, frame, prevSelfHash: previous.hash, prevOppHash: ack.hash };
  p.hash = hashPacketFields(p.matchId, p.frame, p.player, p.inputMask, p.prevSelfHash, p.prevOppHash);
  p.signature = await signDigest("0x" + "1".padStart(64, "0"), p.hash);
  t.packets.push(p);
  const result = await verifyTranscript(t);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.complete, true);
  assert.equal(result.replay.frame, terminal.final.frame);
  assert.equal(result.replay.packetHeads[1], previous.hash);
  assert.equal(result.settlementEligible, false);
  p.signature = "0x" + "00".repeat(65);
  assert.equal((await verifyTranscript(t)).ok, false);
});

test("the terminal result requires its full reachable history", async () => {
  const t = structuredClone(terminal);
  t.canonicalFrames = t.canonicalFrames.slice(-1);
  t.packets = t.packets.slice(-2);
  assert.equal((await verifyTranscript(t)).ok, false);
});
