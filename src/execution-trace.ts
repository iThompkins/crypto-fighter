import { AbiCoder, id, keccak256 } from "ethers";
import * as game from "./game.ts";
import { ZERO32 } from "./crypto.ts";
import { verifyTranscript } from "./verifier.ts";
import { CANONICAL_RULES_HASH, hashTraceState } from "./protocol.ts";
export { encodeTraceState, hashTraceState } from "./protocol.ts";
import type { MatchTranscript } from "./types.ts";

const abi = AbiCoder.defaultAbiCoder();
const digest = (types: string[], values: unknown[]) => keccak256(abi.encode(types, values));
const tag = (name: string) => id(`CryptoFighter:experimental-offchain-trace-v1:${name}`);
export const TRACE_DEPTH = 9;
export const TRACE_LAST_INDEX = game.ROUND_FRAMES;
const hash32 = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

export type TraceCheckpoint = {
  stateHash: string;
  frameHead: string;
  p1Head: string;
  p2Head: string;
  // Previous heads authenticate the F-2 acknowledgements in a single step.
  p1PreviousHead: string;
  p2PreviousHead: string;
};
export function hashCheckpoint(checkpoint: TraceCheckpoint): string {
  const values = [checkpoint.stateHash, checkpoint.frameHead, checkpoint.p1Head, checkpoint.p2Head, checkpoint.p1PreviousHead, checkpoint.p2PreviousHead];
  if (!values.every(hash32)) throw new Error("invalid checkpoint hash");
  return digest(Array(7).fill("bytes32"), [tag("checkpoint"), ...values]);
}
function leaf(contextHash: string, index: number, checkpointHash: string): string {
  return digest(["bytes32", "bytes32", "uint256", "bytes32"], [tag("leaf"), contextHash, index, checkpointHash]);
}
function node(left: string, right: string): string {
  return digest(["bytes32", "bytes32", "bytes32"], [tag("node"), left, right]);
}
export type TraceOpening = { index: number; checkpoint: TraceCheckpoint; siblings: string[] };
export type ExecutionTrace = {
  format: "experimental-offchain-trace-v1";
  settlementEligible: false;
  contextHash: string;
  rulesHash: string;
  root: string;
  terminalFrame: number;
  terminalStateHash: string;
  checkpoints: TraceCheckpoint[];
  levels: string[][];
};

export async function buildExecutionTrace(value: unknown): Promise<ExecutionTrace> {
  // Snapshot before awaiting so mutation during signature verification cannot
  // change the committed inputs after they have been checked.
  const transcript = structuredClone(value) as MatchTranscript;
  const verified = await verifyTranscript(transcript);
  if (!verified.ok || !verified.complete) throw new Error(`complete terminal transcript required: ${verified.errors.join("; ")}`);
  // Deliberately NOT the future escrow context. V1 has no chain/arena/delegation
  // signatures, so this experimental domain can never authorize a payout.
  const contextHash = digest(
    ["bytes32", "bytes32", "bytes32", "address", "address", "bytes32", "bytes32"],
    [tag("offchain-context"), transcript.matchId, CANONICAL_RULES_HASH,
      transcript.players.p1.address, transcript.players.p2.address,
      keccak256(transcript.players.p1.publicKey), keccak256(transcript.players.p2.publicKey)],
  );
  const packetHashes = new Map(transcript.packets.map((p) => [`${p.frame}:${p.player}`, p.hash]));
  const checkpoints: TraceCheckpoint[] = [{
    stateHash: hashTraceState(verified.states[0]), frameHead: ZERO32,
    p1Head: ZERO32, p2Head: ZERO32, p1PreviousHead: ZERO32, p2PreviousHead: ZERO32,
  }];
  for (let frame = 1; frame <= verified.replay.frame; frame++) {
    const previous = checkpoints[frame - 1];
    checkpoints.push({
      stateHash: hashTraceState(verified.states[frame]), frameHead: transcript.canonicalFrames[frame - 1].frameHash,
      p1Head: packetHashes.get(`${frame}:1`)!, p2Head: packetHashes.get(`${frame}:2`)!,
      p1PreviousHead: previous.p1Head, p2PreviousHead: previous.p2Head,
    });
  }
  // Fixed comparison horizon supports different claimed terminal lengths. These
  // are absorbing checkpoints, never additional executed canonical frames.
  const terminal = checkpoints.at(-1)!;
  while (checkpoints.length <= TRACE_LAST_INDEX) checkpoints.push({ ...terminal });
  const leaves = checkpoints.map((checkpoint, index) => leaf(contextHash, index, hashCheckpoint(checkpoint)));
  while (leaves.length < 2 ** TRACE_DEPTH) {
    leaves.push(digest(["bytes32", "bytes32", "uint256"], [tag("padding"), contextHash, leaves.length]));
  }
  const levels = [leaves];
  while (levels.at(-1)!.length > 1) {
    const previous = levels.at(-1)!;
    const next = [];
    for (let i = 0; i < previous.length; i += 2) next.push(node(previous[i], previous[i + 1]));
    levels.push(next);
  }
  return {
    format: "experimental-offchain-trace-v1", settlementEligible: false,
    contextHash, rulesHash: CANONICAL_RULES_HASH, root: levels.at(-1)![0],
    terminalFrame: verified.replay.frame, terminalStateHash: terminal.stateHash, checkpoints, levels,
  };
}

export function openTrace(trace: ExecutionTrace, index: number): TraceOpening {
  if (!Number.isInteger(index) || index < 0 || index > TRACE_LAST_INDEX) throw new Error("invalid trace index");
  const siblings = [];
  let cursor = index;
  for (let depth = 0; depth < TRACE_DEPTH; depth++) {
    siblings.push(trace.levels[depth][cursor ^ 1]);
    cursor = Math.floor(cursor / 2);
  }
  return { index, checkpoint: { ...trace.checkpoints[index] }, siblings };
}

export function verifyTraceOpening(root: string, contextHash: string, opening: TraceOpening): boolean {
  try {
    if (!hash32(root) || !hash32(contextHash) || !Number.isInteger(opening.index) || opening.index < 0 || opening.index > TRACE_LAST_INDEX ||
        opening.siblings.length !== TRACE_DEPTH || !opening.siblings.every(hash32)) return false;
    let current = leaf(contextHash, opening.index, hashCheckpoint(opening.checkpoint));
    let index = opening.index;
    for (const sibling of opening.siblings) {
      current = index % 2 === 0 ? node(current, sibling) : node(sibling, current);
      index = Math.floor(index / 2);
    }
    return current.toLowerCase() === root.toLowerCase();
  } catch { return false; }
}

// Full off-chain verification of a received commitment, not merely membership
// of a supplied checkpoint in an otherwise untrusted root.
export async function verifyExecutionTraceCommitment(transcript: unknown, claim: unknown): Promise<boolean> {
  try {
    if (typeof claim !== "object" || claim === null) return false;
    const snapshot = structuredClone(claim) as Record<string, unknown>;
    const rebuilt = await buildExecutionTrace(transcript);
    return (["format", "settlementEligible", "contextHash", "rulesHash", "root", "terminalFrame", "terminalStateHash"] as const)
      .every((field) => snapshot[field] === rebuilt[field]);
  } catch { return false; }
}
