import { keccak256, toUtf8Bytes } from "ethers";
import { addressFromPublicKey, hashFrameFields, ZERO32 } from "./crypto.ts";
import { initialState, transition, ROUND_FRAMES, INPUT_DELAY } from "./game.ts";
import { verifyGenesisAuthorization, type GenesisRecord } from "./genesis.ts";
import { configHash, parseLiveMessage, verifyReady, exact, object, type LiveConfig, type Ready } from "./live-protocol.ts";
import { createPacketEvidence } from "./match-evidence.ts";
import { CANONICAL_RULES, hashTraceState } from "./protocol.ts";
import { verifyTranscript } from "./verifier.ts";
import type { EvidenceEvent } from "./evidence-store.ts";
import type { CanonicalFrame, GameState, MatchTranscript, SignedInputPacket } from "./types.ts";

export type EvidenceArchive = { format: "phase-b-journal-v1"; journal: EvidenceEvent[] };
export const MAX_EVIDENCE_ROWS = 10000;
export const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
// Stable JSON is the byte format for exports and comparisons, not a new numeric
// protocol. Integers/states still use the unchanged canonical v2 ABI codec.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  throw new Error("Canonical JSON requires finite integers and JSON values");
}
export const publicArtifactHash = (domain: string, value: unknown) => keccak256(toUtf8Bytes(canonicalJson({ domain, value })));
function normalizeHex<T>(value: T): T {
  if (typeof value === "string") return (/^0x[0-9a-fA-F]+$/.test(value) ? value.toLowerCase() : value) as T;
  if (Array.isArray(value)) return value.map(normalizeHex) as T;
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeHex(v)])) as T;
  return value;
}
export type Reconstruction = {
  status: "complete" | "incomplete" | "conflict" | "invalid-chain" | "outside-horizon";
  context: string; config: LiveConfig; evidenceHash: string; journalHash: string;
  readiness: Ready[]; missingReadiness: (1 | 2)[]; signedPackets: SignedInputPacket[]; conflicts: SignedInputPacket[][];
  missing: { player: 1 | 2; frame: number }[]; outOfHorizon: { player: 1 | 2; frame: number }[]; chainMismatches: { player: 1 | 2; frame: number; chain: string }[];
  transcript: MatchTranscript | null; states: GameState[]; gameplayComplete: boolean;
  settlementEligible: false;
};
function packetOrder(a: SignedInputPacket, b: SignedInputPacket) { return a.frame - b.frame || a.player - b.player || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0); }

export async function reconstructEvidence(value: unknown): Promise<Reconstruction> {
  if (!object(value) || !exact(value, ["format", "journal"]) || value.format !== "phase-b-journal-v1" || !Array.isArray(value.journal) || !value.journal.length || value.journal.length > MAX_EVIDENCE_ROWS) throw new Error("Versioned complete journal required");
  if (canonicalJson(value).length > MAX_EVIDENCE_BYTES) throw new Error("Evidence archive too large");
  const archive = structuredClone(value) as EvidenceArchive;
  const genesis = archive.journal[0];
  if (!object(genesis) || genesis.kind !== "genesis" || (genesis.localSlot !== 1 && genesis.localSlot !== 2)) throw new Error("Invalid journal genesis");
  configHash(genesis.config);
  const config = normalizeHex(genesis.config as LiveConfig);
  const context = configHash(config);
  if (!exact(genesis, ["kind", "config", "localSlot", ...(config.mode === "escrow" ? ["record"] : [])])) throw new Error("Invalid genesis fields");
  if (config.mode === "escrow") {
    const record = genesis.record;
    if (!object(record) || !exact(record, ["binding", "authorized", "registrationChallengeId", ...(record.lookup === undefined ? [] : ["lookup"])]) || record.authorized !== true || canonicalJson(normalizeHex(record.binding)) !== canonicalJson(config.authorization!.binding) || !verifyGenesisAuthorization(config.authorization!, record as GenesisRecord)) throw new Error("Invalid historical authorization evidence");
    // This checks public signatures/binding consistency, not canonical-chain truth.
    if (record.lookup !== undefined && (!object(record.lookup) || !exact(record.lookup, ["chainId", "arena", "challengeId", "blockNumber"]) || record.lookup.chainId !== config.authorization!.binding.chainId || String(record.lookup.arena).toLowerCase() !== config.authorization!.binding.arena.toLowerCase() || record.lookup.challengeId !== config.authorization!.binding.challengeId || !Number.isSafeInteger(record.lookup.blockNumber) || Number(record.lookup.blockNumber) < 0)) throw new Error("Invalid lookup provenance");
  }
  const readiness = new Map<number, Ready>();
  const collector = createPacketEvidence(config.matchId, addressFromPublicKey(config.p1PublicKey), addressFromPublicKey(config.p2PublicKey));
  const variants = new Map<string, SignedInputPacket>();
  let observations = 0;
  for (const row of archive.journal.slice(1)) {
    if (!object(row)) throw new Error("Invalid journal row");
    if (row.kind === "observation") {
      const o = row.observation;
      if (!exact(row, ["kind", "observation"]) || !object(o) || !exact(o, ["kind", "localTime", "frame"]) || !["disconnect", "reconnect"].includes(String(o.kind)) || !Number.isSafeInteger(o.localTime) || Number(o.localTime) < 0 || !Number.isSafeInteger(o.frame) || Number(o.frame) < 0 || Number(o.frame) > ROUND_FRAMES || ++observations > 1024) throw new Error("Invalid local observation");
      continue;
    }
    if (row.kind !== "message" || !exact(row, ["kind", "message"])) throw new Error("Unexpected journal row");
    const m = parseLiveMessage(normalizeHex(row.message));
    if (m.context !== context || m.type === "REQUEST") throw new Error("Wrong lifecycle domain or non-evidence request");
    if (m.type === "READY") {
      verifyReady(config, m, m.slot);
      const previous = readiness.get(m.slot);
      if (!previous || canonicalJson(m) < canonicalJson(previous)) readiness.set(m.slot, m);
    } else {
      const result = await collector.receive(m.packet);
      if (result.kind === "unattributed-rejection") throw new Error(`Invalid authenticated evidence: ${result.reason}`);
      const p = m.packet, key = `${p.player}:${p.frame}:${p.hash}`;
      const previous = variants.get(key);
      // Payload duplicates do not become equivocation merely because signature
      // encoding differs. Choose the lexical minimum verified representation.
      if (!previous || canonicalJson(p) < canonicalJson(previous)) variants.set(key, p);
    }
  }
  const signedPackets = [...variants.values()].sort(packetOrder);
  const grouped = new Map<string, SignedInputPacket[]>();
  for (const p of signedPackets) { const k = `${p.player}:${p.frame}`; const group = grouped.get(k) ?? []; group.push(p); grouped.set(k, group); }
  const conflicts = [...grouped.values()].filter(group => group.length > 1);
  const ready = [...readiness.values()].sort((a, b) => a.slot - b.slot);
  const evidenceHash = publicArtifactHash("CryptoFighter.CanonicalEvidence.v1", { config, readiness: ready, signedPackets });
  const base = { context, config, evidenceHash, journalHash: publicArtifactHash("CryptoFighter.Journal.v1", archive), readiness: ready, missingReadiness: ([1, 2] as const).filter(slot => !readiness.has(slot)), signedPackets, conflicts,
    missing: [] as Reconstruction["missing"], outOfHorizon: [] as Reconstruction["outOfHorizon"], chainMismatches: [] as Reconstruction["chainMismatches"], settlementEligible: false as const };
  // Scan every supplied signed variant (including unused tail evidence) before
  // emitting any canonical gameplay. Never select a convenient branch.
  if (conflicts.length) return { ...base, status: "conflict", transcript: null, states: [], gameplayComplete: false };
  const missing = new Map<string, { player: 1 | 2; frame: number }>();
  for (const p of signedPackets) {
    const check = collector.chainEvidence(p.player, p.frame);
    if (check.kind === "missing-dependency") missing.set(`${check.player}:${check.frame}`, { player: check.player, frame: check.frame });
    if (check.kind === "chain-mismatch") base.chainMismatches.push({ player: p.player, frame: p.frame, chain: check.chain });
  }
  if (base.chainMismatches.length) return { ...base, status: "invalid-chain", transcript: null, states: [], gameplayComplete: false };
  const valid = new Map(collector.validatedPackets().map(p => [`${p.player}:${p.frame}`, p]));
  let state = initialState(), frameHead = ZERO32;
  const states = [state], frames: CanonicalFrame[] = [], executed: SignedInputPacket[] = [];
  while (readiness.size === 2 && !state.roundOver) {
    const frame = state.frame + 1;
    const p1 = valid.get(`1:${frame}`), p2 = valid.get(`2:${frame}`);
    if (!p1 || !p2) {
      for (const player of [1, 2] as const) if (!grouped.has(`${player}:${frame}`)) missing.set(`${player}:${frame}`, { player, frame });
      break;
    }
    const frameHash = hashFrameFields(config.matchId, frame, p1.inputMask, p2.inputMask, frameHead);
    frames.push({ matchId: config.matchId, frame, p1InputMask: p1.inputMask, p2InputMask: p2.inputMask, prevFrameHash: frameHead, frameHash });
    // Use the deterministic verified representation selected above, never arrival order.
    executed.push(variants.get(`1:${frame}:${p1.hash}`)!, variants.get(`2:${frame}:${p2.hash}`)!);
    state = transition(state, p1.inputMask, p2.inputMask); states.push(state); frameHead = frameHash;
  }
  if (state.roundOver) base.outOfHorizon = signedPackets.filter(p => p.frame > state.frame + INPUT_DELAY).map(p => ({ player: p.player, frame: p.frame }));
  base.missing = [...missing.values()].sort((a, b) => a.frame - b.frame || a.player - b.player);
  const transcript: MatchTranscript = {
    version: 2, rulesHash: config.rulesHash, matchId: config.matchId, rules: { ...CANONICAL_RULES },
    players: { p1: { slot: 1, address: addressFromPublicKey(config.p1PublicKey), publicKey: config.p1PublicKey }, p2: { slot: 2, address: addressFromPublicKey(config.p2PublicKey), publicKey: config.p2PublicKey } },
    packets: executed, canonicalFrames: frames,
    final: { frame: state.frame, frameHash: frameHead, stateHash: hashTraceState(state), p1Hp: state.p1.hp, p2Hp: state.p2.hp, winner: state.winner, roundOver: state.roundOver },
  };
  const checked = await verifyTranscript(transcript, { allowPartial: true });
  if (!checked.ok) throw new Error(`Canonical reconstruction failed: ${checked.errors.join("; ")}`);
  return { ...base, status: base.outOfHorizon.length ? "outside-horizon" : state.roundOver && readiness.size === 2 && !missing.size ? "complete" : "incomplete", transcript, states, gameplayComplete: state.roundOver };
}
