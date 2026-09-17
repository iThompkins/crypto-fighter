import { addressFromPublicKey, hashFrameFields, hashJson, hashPacketFields, verifyPacket, ZERO32 } from "./crypto.ts";
import { INPUT_DELAY, MAX_HP, ROUND_FRAMES, initialState, transition } from "./game.ts";
import { isValidV1InputMask } from "./input-mask.ts";
import type { GameState, MatchTranscript, SignedInputPacket } from "./types.ts";

import { CANONICAL_V1_RULES as V1_RULES } from "./protocol.ts";
export type TranscriptVerificationResult = {
  ok: boolean;
  complete: boolean;
  // V1 packets lack escrow domain binding. Even complete replay is not payout authorization.
  settlementEligible: false;
  errors: string[];
  states: GameState[];
  replay: {
    frame: number; frameHash: string; stateHash: string; p1Hp: number; p2Hp: number;
    winner: GameState["winner"]; roundOver: boolean;
    packetHeads: { 1: string; 2: string };
  };
};

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hex = (value: unknown, bytes: number) => typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value);
const integer = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

function preflight(value: unknown): string[] {
  if (!object(value)) return ["transcript must be an object"];
  if (!Array.isArray(value.packets) || !Array.isArray(value.canonicalFrames)) return ["packet and canonical histories are required arrays"];
  if (value.canonicalFrames.length > ROUND_FRAMES || value.packets.length > 2 * (ROUND_FRAMES + INPUT_DELAY)) return ["history exceeds v1 bounds"];
  const errors: string[] = [];
  // Preserve the mask preflight, including unused delayed packets.
  for (const [i, p] of value.packets.entries()) {
    if (!isValidV1InputMask(p?.inputMask)) errors.push(`invalid v1 input mask at packets[${i}].inputMask`);
  }
  for (const [i, f] of value.canonicalFrames.entries()) {
    if (!isValidV1InputMask(f?.p1InputMask)) errors.push(`invalid v1 input mask at canonicalFrames[${i}].p1InputMask`);
    if (!isValidV1InputMask(f?.p2InputMask)) errors.push(`invalid v1 input mask at canonicalFrames[${i}].p2InputMask`);
  }
  if (errors.length) return errors;
  if (value.version !== 1) errors.push("unsupported transcript version");
  if (!hex(value.matchId, 32) || value.matchId === ZERO32) errors.push("invalid matchId");
  const rules = value.rules;
  if (!object(rules) || Object.keys(rules).length !== Object.keys(V1_RULES).length ||
      Object.entries(V1_RULES).some(([key, expected]) => rules[key] !== expected)) errors.push("rules must match pinned v1 rules");
  if (!object(value.players)) errors.push("player identities required");
  else {
    for (const [key, slot] of [["p1", 1], ["p2", 2]] as const) {
      const p = value.players[key];
      if (!object(p) || p.slot !== slot || !hex(p.address, 20) || typeof p.publicKey !== "string" || !/^0x04[0-9a-fA-F]{128}$/.test(p.publicKey)) {
        errors.push(`invalid P${slot} identity`);
      }
    }
  }
  for (const [i, p] of value.packets.entries()) {
    if (!object(p) || !integer(p.frame, 1, value.canonicalFrames.length + INPUT_DELAY) || (p.player !== 1 && p.player !== 2) ||
        !hex(p.matchId, 32) || !hex(p.hash, 32) || !hex(p.prevSelfHash, 32) || !hex(p.prevOppHash, 32) ||
        !hex(p.signature, 65) || typeof p.publicKey !== "string" || !/^0x04[0-9a-fA-F]{128}$/.test(p.publicKey)) errors.push(`invalid packet at packets[${i}]`);
  }
  for (const [i, f] of value.canonicalFrames.entries()) {
    if (!object(f) || f.frame !== i + 1 || !hex(f.matchId, 32) || !hex(f.frameHash, 32) || !hex(f.prevFrameHash, 32)) errors.push(`invalid or noncontiguous canonical frame at canonicalFrames[${i}]`);
  }
  const f = value.final;
  if (!object(f) || !integer(f.frame, 0, ROUND_FRAMES) || !hex(f.frameHash, 32) || !hex(f.stateHash, 32) ||
      !integer(f.p1Hp, 0, MAX_HP) || !integer(f.p2Hp, 0, MAX_HP) || typeof f.roundOver !== "boolean" ||
      ![null, "P1", "P2", "TIE_BOTH_LOSE"].includes(f.winner as GameState["winner"])) errors.push("complete final record required");
  return errors;
}

export async function verifyTranscript(value: unknown, options: { allowPartial?: boolean } = {}): Promise<TranscriptVerificationResult> {
  const errors = preflight(value);
  const states: GameState[] = [initialState()];
  let state = states[0];
  let frameHead = ZERO32;
  const packetHeads: { 1: string; 2: string } = { 1: ZERO32, 2: ZERO32 };
  const result = (): TranscriptVerificationResult => ({
    ok: errors.length === 0,
    complete: errors.length === 0 && state.roundOver,
    settlementEligible: false,
    errors, states,
    replay: { frame: state.frame, frameHash: frameHead, stateHash: hashJson(state), p1Hp: state.p1.hp, p2Hp: state.p2.hp, winner: state.winner, roundOver: state.roundOver, packetHeads },
  });
  if (errors.length) return result();
  const transcript = value as MatchTranscript;
  for (const player of [transcript.players.p1, transcript.players.p2]) {
    try {
      if (addressFromPublicKey(player.publicKey).toLowerCase() !== player.address.toLowerCase()) errors.push(`P${player.slot} session address does not match public key`);
    } catch { errors.push(`P${player.slot} public key is malformed`); }
  }
  if (transcript.players.p1.address.toLowerCase() === transcript.players.p2.address.toLowerCase()) errors.push("players must have distinct session identities");
  const packets = new Map<string, SignedInputPacket>();
  const hist: { 1: Map<number, string>; 2: Map<number, string> } = { 1: new Map(), 2: new Map() };
  // Authenticate every supplied packet, including the unused input-delay tail.
  for (const p of [...transcript.packets].sort((a, b) => a.frame - b.frame || a.player - b.player)) {
    const key = `${p.frame}:${p.player}`;
    if (packets.has(key)) errors.push(`duplicate packet ${key}`);
    packets.set(key, p);
    const expectedHash = hashPacketFields(p.matchId, p.frame, p.player, p.inputMask, p.prevSelfHash, p.prevOppHash);
    if (p.matchId !== transcript.matchId) errors.push(`${key}: wrong matchId`);
    if (p.hash !== expectedHash) errors.push(`${key}: hash mismatch`);
    if (p.prevSelfHash !== (p.frame === 1 ? ZERO32 : hist[p.player].get(p.frame - 1))) errors.push(`${key}: broken self chain`);
    const opponent = p.player === 1 ? 2 : 1;
    const ack = p.frame - INPUT_DELAY;
    if (p.prevOppHash !== (ack < 1 ? ZERO32 : hist[opponent].get(ack))) errors.push(`${key}: broken opponent acknowledgement`);
    const identity = p.player === 1 ? transcript.players.p1 : transcript.players.p2;
    if (p.publicKey !== identity.publicKey) errors.push(`${key}: public key mismatch`);
    if (!await verifyPacket(p)) errors.push(`${key}: invalid signature`);
    hist[p.player].set(p.frame, p.hash);
  }
  for (const canonical of transcript.canonicalFrames) {
    if (state.roundOver) { errors.push("canonical history continues after terminal state"); break; }
    const frame = canonical.frame;
    const p1 = packets.get(`${frame}:1`), p2 = packets.get(`${frame}:2`);
    if (!p1 || !p2) { errors.push(`missing packet pair for frame ${frame}`); break; }
    const expected = hashFrameFields(transcript.matchId, frame, p1.inputMask, p2.inputMask, frameHead);
    if (canonical.matchId !== transcript.matchId) errors.push(`frame ${frame}: canonical matchId mismatch`);
    if (canonical.p1InputMask !== p1.inputMask || canonical.p2InputMask !== p2.inputMask) errors.push(`frame ${frame}: canonical input mismatch`);
    if (canonical.prevFrameHash !== frameHead || canonical.frameHash !== expected) errors.push(`frame ${frame}: canonical hash mismatch`);
    frameHead = expected;
    packetHeads[1] = p1.hash; packetHeads[2] = p2.hash;
    state = transition(state, p1.inputMask, p2.inputMask);
    states.push(state);
  }
  const actual = result().replay;
  for (const key of ["frame", "frameHash", "stateHash", "p1Hp", "p2Hp", "winner", "roundOver"] as const) {
    if (transcript.final[key] !== actual[key]) errors.push(`final ${key} mismatch`);
  }
  if (!state.roundOver && !options.allowPartial) errors.push("terminal history required; partial replay is not terminal evidence");
  return result();
}
