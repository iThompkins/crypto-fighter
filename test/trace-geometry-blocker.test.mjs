import assert from "node:assert/strict";
import test from "node:test";
import { initialState, transition, SCALE } from "../src/game.ts";
import { CANONICAL_RULES, CANONICAL_RULES_HASH, hashTraceState } from "../src/protocol.ts";
import { hashFrameFields, hashPacketFields, ZERO32 } from "../src/crypto.ts";
import { buildExecutionTrace, buildAuthorizedExecutionTrace } from "../src/execution-trace.ts";
import { verifyTranscript } from "../src/verifier.ts";
import { w1, w2, binding, auth, record } from "./fixtures/genesis.mjs";

// Former codec blocker: an honest wall/recollision transcript is now encodable.
test("valid collision-wall-recollision history is exactly committed by the fixed-point codec", async () => {
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
  assert.deepEqual(positions.get(85), [544.5 * SCALE, 572.5 * SCALE]);
  assert.deepEqual(positions.get(195), [0, 572.5 * SCALE]);
  assert.deepEqual(positions.get(250), [272.25 * SCALE, 300.25 * SCALE]);
  assert.equal(state.winner, "TIE_BOTH_LOSE");
  const transcript = {
    version: 2, rulesHash: CANONICAL_RULES_HASH, matchId: binding.genesis, rules: CANONICAL_RULES,
    players: { p1: { slot: 1, address: w1.address, publicKey: w1.signingKey.publicKey }, p2: { slot: 2, address: w2.address, publicKey: w2.signingKey.publicKey } },
    packets, canonicalFrames,
    final: { frame: 300, frameHash: frameHead, stateHash: hashTraceState(state), p1Hp: 7, p2Hp: 7, winner: state.winner, roundOver: true },
  };
  const verified = await verifyTranscript(transcript);
  assert.equal(verified.ok, true, verified.errors.join("; "));
  assert.equal(verified.complete, true);
  assert.equal(hashTraceState(state), verified.replay.stateHash);
  assert.equal((await buildExecutionTrace(transcript)).terminalStateHash, verified.replay.stateHash);
  assert.equal((await buildAuthorizedExecutionTrace(transcript, auth, record)).terminalStateHash, verified.replay.stateHash);
});
