import assert from "node:assert/strict";
import test from "node:test";
import { initialState, transition } from "../src/game.ts";
import { CANONICAL_V1_RULES, hashTraceState } from "../src/protocol.ts";
import { hashFrameFields, hashJson, hashPacketFields, ZERO32 } from "../src/crypto.ts";
import { buildExecutionTrace, buildAuthorizedExecutionTrace } from "../src/execution-trace.ts";
import { verifyTranscript } from "../src/verifier.ts";
import { w1, w2, binding, auth, record } from "./fixtures/genesis.mjs";

// Known protocol blocker, not desired codec behavior. Once the replacement
// encoding is approved this test must require successful exact commitments.
test("valid collision-wall-recollision history exceeds the current half-unit trace encoding", async () => {
  let state = initialState(), frameHead = ZERO32;
  const packets = [], canonicalFrames = [], history = [[], []];
  const positions = new Map();
  for (let frame = 1; frame <= 300; frame++) {
    const masks = frame <= 85 ? [2, 0] : frame <= 195 ? [1, 0] : frame <= 250 ? [2, 1] : [0, 0];
    for (const [i, wallet] of [w1, w2].entries()) {
      const p = {
        matchId: binding.genesis, frame, player: i + 1, inputMask: masks[i],
        prevSelfHash: history[i][frame - 1] ?? ZERO32,
        prevOppHash: history[1 - i][frame - 2] ?? ZERO32,
        publicKey: wallet.signingKey.publicKey,
      };
      const hash = hashPacketFields(p.matchId, frame, p.player, p.inputMask, p.prevSelfHash, p.prevOppHash);
      packets.push({ ...p, hash, signature: wallet.signingKey.sign(hash).serialized });
      history[i][frame] = hash;
    }
    const next = hashFrameFields(binding.genesis, frame, ...masks, frameHead);
    canonicalFrames.push({ matchId: binding.genesis, frame, p1InputMask: masks[0], p2InputMask: masks[1], prevFrameHash: frameHead, frameHash: next });
    frameHead = next;
    state = transition(state, ...masks);
    if ([85, 195, 250].includes(frame)) positions.set(frame, [state.p1.x, state.p2.x]);
  }
  assert.deepEqual(positions.get(85), [544.5, 572.5]);
  assert.deepEqual(positions.get(195), [0, 572.5]);
  assert.deepEqual(positions.get(250), [272.25, 300.25]);
  assert.equal(state.winner, "TIE_BOTH_LOSE");
  const transcript = {
    version: 1, matchId: binding.genesis, rules: CANONICAL_V1_RULES,
    players: { p1: { slot: 1, address: w1.address, publicKey: w1.signingKey.publicKey }, p2: { slot: 2, address: w2.address, publicKey: w2.signingKey.publicKey } },
    packets, canonicalFrames,
    final: { frame: 300, frameHash: frameHead, stateHash: hashJson(state), p1Hp: 7, p2Hp: 7, winner: state.winner, roundOver: true },
  };
  const verified = await verifyTranscript(transcript);
  assert.equal(verified.ok, true, verified.errors.join("; "));
  assert.equal(verified.complete, true);
  assert.throws(() => hashTraceState(state), /exact safe integers/);
  await assert.rejects(buildExecutionTrace(transcript), /exact safe integers/);
  await assert.rejects(buildAuthorizedExecutionTrace(transcript, auth, record), /exact safe integers/);
});
