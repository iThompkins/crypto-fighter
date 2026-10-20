import { hashCheckpoint, verifyTraceOpening, type TraceOpening } from "./execution-trace.ts";
import { loadEvidenceDefense } from "./evidence-trace.ts";
import type { GenesisRecord } from "./genesis.ts";
import type { GameState, SignedInputPacket } from "./types.ts";

const ZERO32 = "0x" + "00".repeat(32);
const outcome = (winner: GameState["winner"]) => winner === "P1" ? 1 : winner === "P2" ? 2 : winner === "TIE_BOTH_LOSE" ? 3 : 0;

export function solidityState(state: GameState) {
  return {
    frame: state.frame,
    timer: state.timerFramesLeft,
    terminal: state.roundOver,
    outcome: outcome(state.winner),
    p1: { ...state.p1 },
    p2: { ...state.p2 },
  };
}

export function solidityOpening(opening: TraceOpening) {
  return { checkpoint: { ...opening.checkpoint }, siblings: [...opening.siblings] };
}

export function solidityPacket(packet: SignedInputPacket) {
  return {
    matchId: packet.matchId,
    frame: packet.frame,
    player: packet.player,
    inputMask: packet.inputMask,
    prevSelfHash: packet.prevSelfHash,
    prevOppHash: packet.prevOppHash,
    signature: packet.signature,
  };
}

const emptyPacket = () => ({
  matchId: ZERO32, frame: 0, player: 0, inputMask: 0,
  prevSelfHash: ZERO32, prevOppHash: ZERO32, signature: "0x",
});

function requireIndependentBundle(value: unknown, record: GenesisRecord | undefined) {
  if (!record) throw new Error("A freshly read independent genesis record is required");
  if (!value || typeof value !== "object" || (value as { authority?: unknown }).authority !== "independent-record") {
    throw new Error("Rebuild the evidence bundle with the independent record before preparing on-chain calldata");
  }
  return record;
}

export async function prepareTraceClaim(value: unknown, record?: GenesisRecord) {
  const defense = await loadEvidenceDefense(value, requireIndependentBundle(value, record));
  return {
    format: "crypto-fighter-trace-claim-v1" as const,
    root: defense.commitment!.root,
    genesis: solidityOpening(defense.opening(0)),
    endpoint: solidityOpening(defense.opening(300)),
    terminalState: solidityState(defense.terminalState),
    archivePublication: { root: defense.commitment!.root, journalHash: defense.journalHash },
    settlementEligible: false as const,
  };
}

export async function prepareTraceChallenge(value: unknown, record?: GenesisRecord) {
  const defense = await loadEvidenceDefense(value, requireIndependentBundle(value, record));
  return {
    format: "crypto-fighter-trace-challenge-v1" as const,
    root: defense.commitment!.root,
    genesis: solidityOpening(defense.opening(0)),
    endpoint: solidityOpening(defense.opening(300)),
    settlementEligible: false as const,
  };
}

export async function prepareMidpointOpening(value: unknown, index: number, record?: GenesisRecord) {
  const defense = await loadEvidenceDefense(value, requireIndependentBundle(value, record));
  return {
    format: "crypto-fighter-trace-midpoint-v1" as const,
    index,
    opening: solidityOpening(defense.opening(index)),
    settlementEligible: false as const,
  };
}

export type AdjudicationComparison = {
  contextHash: string;
  claimantRoot: string;
  challengerRoot: string;
  claimantBefore: TraceOpening;
  claimantAfter: TraceOpening;
  challengerAfter: TraceOpening;
};

export async function prepareAdjudicationWitness(
  value: unknown,
  frame: number,
  comparison: AdjudicationComparison,
  record?: GenesisRecord,
) {
  const defense = await loadEvidenceDefense(value, requireIndependentBundle(value, record));
  if (comparison.contextHash !== defense.commitment!.contextHash) throw new Error("Dispute context does not match evidence");
  if (comparison.claimantBefore.index !== frame - 1 || comparison.claimantAfter.index !== frame || comparison.challengerAfter.index !== frame) throw new Error("Wrong adjudication opening index");
  if (!verifyTraceOpening(comparison.claimantRoot, comparison.contextHash, comparison.claimantBefore) ||
      !verifyTraceOpening(comparison.claimantRoot, comparison.contextHash, comparison.claimantAfter) ||
      !verifyTraceOpening(comparison.challengerRoot, comparison.contextHash, comparison.challengerAfter)) {
    throw new Error("Invalid committed adjudication opening");
  }
  const step = defense.step(frame);
  if (hashCheckpoint(comparison.claimantBefore.checkpoint) !== hashCheckpoint(step.before.checkpoint)) throw new Error("Claimant pre-state is not the agreed evidence checkpoint");
  const canonicalPost = hashCheckpoint(step.after.checkpoint);
  const claimantPost = hashCheckpoint(comparison.claimantAfter.checkpoint);
  const challengerPost = hashCheckpoint(comparison.challengerAfter.checkpoint);
  return {
    format: "crypto-fighter-step-witness-v1" as const,
    frame,
    beforeOpening: solidityOpening(comparison.claimantBefore),
    beforeState: solidityState(step.kind === "execution" ? step.preState : step.terminalState),
    p1: step.kind === "execution" ? solidityPacket(step.p1) : emptyPacket(),
    p2: step.kind === "execution" ? solidityPacket(step.p2) : emptyPacket(),
    claimantAfter: solidityOpening(comparison.claimantAfter),
    challengerAfter: solidityOpening(comparison.challengerAfter),
    canonicalPost,
    expectedVerdict: canonicalPost === claimantPost ? "claimant" as const : canonicalPost === challengerPost ? "challenger" as const : "neither" as const,
    settlementEligible: false as const,
  };
}
