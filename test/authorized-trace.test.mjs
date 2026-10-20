import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AbiCoder, id, keccak256 } from "ethers";
import { auth, record } from "./fixtures/genesis.mjs";
import { hashGenesisBinding } from "../src/genesis.ts";
import { buildAuthorizedExecutionTrace, buildExecutionTrace, hashCheckpoint, openTrace, verifyAuthorizedExecutionTraceCommitment, verifyExecutionTraceCommitment, verifyTraceOpening } from "../src/execution-trace.ts";
import { createBisection } from "../src/bisection.ts";

const file = join(await mkdtemp(join(tmpdir(), "crypto-fighter-authorized-")), "terminal.json");
execFileSync(process.execPath, ["tools/make-transcript.mjs", file]);
const transcript = JSON.parse(await readFile(file, "utf8"));
const trace = await buildAuthorizedExecutionTrace(transcript, auth, record);

// An adversary can commit arbitrary states; Merkle membership is not execution.
function fraudulentTrace(firstBadFrame) {
  const fake = structuredClone(trace);
  const abi = AbiCoder.defaultAbiCoder();
  const digest = (types, values) => keccak256(abi.encode(types, values));
  const tag = (name) => id(`CryptoFighter:fixed-point-trace-v2:${name}`);
  for (let i = firstBadFrame; i <= 300; i++) {
    fake.checkpoints[i].stateHash = id("fabricated state");
    fake.levels[0][i] = digest(["bytes32", "bytes32", "uint256", "bytes32"], [tag("leaf"), fake.contextHash, i, hashCheckpoint(fake.checkpoints[i])]);
  }
  for (let level = 1; level < fake.levels.length; level++) {
    for (let i = 0; i < fake.levels[level].length; i++) {
      fake.levels[level][i] = digest(["bytes32", "bytes32", "bytes32"], [tag("node"), fake.levels[level - 1][i * 2], fake.levels[level - 1][i * 2 + 1]]);
    }
  }
  fake.root = fake.levels.at(-1)[0];
  return fake;
}
function dispute(fake, authority = record) {
  return createBisection(auth, authority, { claimant: fake.root, challenger: trace.root },
    { claimant: openTrace(fake, 0), challenger: openTrace(trace, 0) },
    { claimant: openTrace(fake, 300), challenger: openTrace(trace, 300) });
}

test("authorized traces bind the registered context without adding escrow fields to moves", async () => {
  const diagnostic = await buildExecutionTrace(transcript);
  assert.equal(trace.contextHash, hashGenesisBinding(record.binding));
  assert.notEqual(trace.root, diagnostic.root);
  assert.equal(await verifyExecutionTraceCommitment(transcript, { ...diagnostic, genesisAuthorized: true }), false);
  assert.equal(trace.genesis, transcript.matchId);
  assert.equal(trace.genesisAuthorized, true);
  assert.equal(trace.settlementEligible, false);
  assert.equal(await verifyAuthorizedExecutionTraceCommitment(transcript, trace, auth, record), true);
  assert.equal(await verifyAuthorizedExecutionTraceCommitment(transcript, diagnostic, auth, record), false);
  assert.equal(await verifyAuthorizedExecutionTraceCommitment(transcript, trace, auth, { ...record, authorized: false }), false);
  await assert.rejects(buildAuthorizedExecutionTrace({ ...transcript, matchId: id("foreign") }, auth, record));
  assert.equal(verifyTraceOpening(trace.root, diagnostic.contextHash, openTrace(trace, 91)), false);
});

test("authenticated interactive midpoint openings isolate an inconsistent transition in at most nine rounds", () => {
  for (const firstBadFrame of [1, 37, 91, 137, 300]) {
    const fake = fraudulentTrace(firstBadFrame);
    const game = dispute(fake);
    while (!game.snapshot().isolated) {
      const { midpoint, low, high } = game.snapshot();
      game.submit("challenger", openTrace(trace, midpoint));
      assert.equal(game.snapshot().low, low);
      assert.equal(game.snapshot().high, high);
      game.submit("claimant", openTrace(fake, midpoint));
    }
    assert.equal(game.snapshot().low, firstBadFrame - 1);
    assert.equal(game.snapshot().high, firstBadFrame);
    assert.ok(game.snapshot().rounds <= 9);
    assert.equal(game.snapshot().settlementEligible, false);
    assert.throws(() => game.submit("claimant", openTrace(fake, firstBadFrame)), /already isolated/);
  }
});

test("bad, replayed, wrong-index and wrong-root openings cannot advance a round", () => {
  const fake = fraudulentTrace(37), game = dispute(fake);
  const before = game.snapshot();
  assert.throws(() => game.submit("claimant", openTrace(fake, before.midpoint + 1)), /invalid bisection opening/);
  assert.throws(() => game.submit("claimant", openTrace(trace, before.midpoint)), /invalid bisection opening/);
  assert.deepEqual(game.snapshot(), before);
  game.submit("claimant", openTrace(fake, before.midpoint));
  assert.throws(() => game.submit("claimant", openTrace(fake, before.midpoint)), /already opened/);
  game.submit("challenger", openTrace(trace, before.midpoint));
  assert.throws(() => game.submit("claimant", openTrace(fake, before.midpoint)), /invalid bisection opening/);
  assert.throws(() => dispute(fake, { ...record, authorized: false }), /unauthorized genesis/);
  assert.throws(() => dispute(trace), /endpoints do not disagree/);
});
