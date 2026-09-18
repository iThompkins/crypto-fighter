import { reconstructEvidence, canonicalJson, publicArtifactHash, type EvidenceArchive } from "./evidence-archive.ts";
import { buildAuthorizedExecutionTrace, buildExecutionTrace, buildHistoricalExecutionTrace, openTrace } from "./execution-trace.ts";
import { verifyGenesisAuthorization, type GenesisRecord } from "./genesis.ts";
import { TRACE_LAST_INDEX } from "./execution-trace.ts";
import { object } from "./live-protocol.ts";

export async function buildEvidenceBundle(value: unknown, authoritativeRecord?: GenesisRecord) {
  const archive = structuredClone(value) as EvidenceArchive;
  const record = authoritativeRecord && structuredClone(authoritativeRecord);
  const reconstruction = await reconstructEvidence(archive);
  if (reconstruction.config.mode === "practice" && record) throw new Error("Practice evidence cannot acquire escrow authority");
  if (record && reconstruction.config.mode === "escrow" && !verifyGenesisAuthorization(reconstruction.config.authorization!, record)) throw new Error("Independent record does not authorize this evidence");
  const authority = reconstruction.config.mode === "practice" ? "practice" as const : record ? "independent-record" as const : "historical-inspection" as const;
  let trace = null;
  if (reconstruction.status === "complete") {
    if (authority === "practice") trace = await buildExecutionTrace(reconstruction.transcript);
    else if (record) trace = await buildAuthorizedExecutionTrace(reconstruction.transcript, reconstruction.config.authorization!, record);
    else trace = await buildHistoricalExecutionTrace(reconstruction.transcript, reconstruction.config.authorization!, archive.journal[0].record as GenesisRecord);
  }
  const { transcript, states } = reconstruction;
  const commitment = trace ? {
    format: trace.format, contextHash: trace.contextHash, rulesHash: trace.rulesHash, root: trace.root,
    terminalFrame: trace.terminalFrame, terminalStateHash: trace.terminalStateHash, settlementEligible: false as const,
  } : null;
  return {
    format: "phase-c-dispute-bundle-v1" as const, archive, reconstruction, authority,
    transcriptHash: transcript ? publicArtifactHash("CryptoFighter.CanonicalTranscript.v1", transcript) : null,
    statesHash: transcript ? publicArtifactHash("CryptoFighter.CanonicalStates.v1", states) : null,
    trace, commitment,
    endpoints: trace ? { genesis: openTrace(trace, 0), terminal: openTrace(trace, trace.terminalFrame), horizon: openTrace(trace, TRACE_LAST_INDEX) } : null,
    settlementEligible: false as const,
  };
}
export type EvidenceBundle = Awaited<ReturnType<typeof buildEvidenceBundle>>;

// Rebuild every derived field. A claimed root, state, conflict-free flag, or
// purported chain-authority flag in an imported file is never trusted.
export async function loadEvidenceDefense(value: unknown, authoritativeRecord?: GenesisRecord) {
  if (!object(value) || value.format !== "phase-c-dispute-bundle-v1") throw new Error("Invalid defense bundle");
  const snapshot = structuredClone(value);
  const rebuilt = await buildEvidenceBundle(snapshot.archive, authoritativeRecord);
  if (canonicalJson(snapshot) !== canonicalJson(rebuilt)) throw new Error("Defense bundle does not match complete supplied evidence");
  const trace = rebuilt.trace;
  if (!trace || rebuilt.reconstruction.status !== "complete") throw new Error("Complete uncontested evidence required for dispute artifacts");
  const states = rebuilt.reconstruction.states;
  const transcript = rebuilt.reconstruction.transcript!;
  const packets = new Map(transcript.packets.map(p => [`${p.frame}:${p.player}`, p]));
  return {
    commitment: structuredClone(rebuilt.commitment),
    opening(index: number) { return openTrace(trace, index); },
    step(frame: number) {
      if (!Number.isSafeInteger(frame) || frame < 1 || frame > TRACE_LAST_INDEX) throw new Error("Invalid isolated step index");
      const before = openTrace(trace, frame - 1), after = openTrace(trace, frame);
      if (frame > trace.terminalFrame) return structuredClone({ kind: "terminal-absorption" as const, frame, before, after, terminalState: states.at(-1)! });
      return structuredClone({ kind: "execution" as const, frame, before, after, preState: states[frame - 1], postState: states[frame],
        p1: packets.get(`${frame}:1`)!, p2: packets.get(`${frame}:2`)! });
    },
  };
}
export async function verifyEvidenceBundle(value: unknown, authoritativeRecord?: GenesisRecord): Promise<boolean> {
  try {
    if (!object(value) || value.format !== "phase-c-dispute-bundle-v1") return false;
    const snapshot = structuredClone(value);
    return canonicalJson(snapshot) === canonicalJson(await buildEvidenceBundle(snapshot.archive, authoritativeRecord));
  } catch { return false; }
}
