import { hashCheckpoint, TRACE_LAST_INDEX, verifyTraceOpening, type TraceOpening } from "./execution-trace.ts";
import { hashGenesisBinding, verifyGenesisAuthorization, type GenesisAuthorization, type GenesisRecord } from "./genesis.ts";
import { initialState } from "./game.ts";
import { hashTraceState } from "./protocol.ts";
import { ZERO32 } from "./crypto.ts";

type Side = "claimant" | "challenger";
type Pair<T> = { claimant: T; challenger: T };

// Off-chain coordinator only. Roots/participants must later be frozen on-chain;
// this helper neither authenticates transaction senders nor adjudicates payouts.
export function createBisection(
  authorization: GenesisAuthorization,
  record: GenesisRecord,
  roots: Pair<string>,
  genesis: Pair<TraceOpening>,
  endpoints: Pair<TraceOpening>,
) {
  if (!verifyGenesisAuthorization(authorization, record)) throw new Error("unauthorized genesis");
  const contextHash = hashGenesisBinding(record.binding);
  const committedRoots = { ...roots };
  function authenticate(side: Side, opening: TraceOpening, index: number): string {
    if (opening.index !== index || !verifyTraceOpening(committedRoots[side], contextHash, opening)) throw new Error("invalid bisection opening");
    return hashCheckpoint(opening.checkpoint);
  }
  let low = 0, high = TRACE_LAST_INDEX, rounds = 0;
  let agreed = hashCheckpoint({ stateHash: hashTraceState(initialState()), frameHead: ZERO32, p1Head: ZERO32, p2Head: ZERO32, p1PreviousHead: ZERO32, p2PreviousHead: ZERO32 });
  if (authenticate("claimant", genesis.claimant, 0) !== agreed || authenticate("challenger", genesis.challenger, 0) !== agreed) throw new Error("genesis checkpoint mismatch");
  let upper = { claimant: authenticate("claimant", endpoints.claimant, high), challenger: authenticate("challenger", endpoints.challenger, high) };
  if (upper.claimant === upper.challenger) throw new Error("endpoints do not disagree");
  let pending: Partial<Pair<string>> = {};
  const snapshot = () => ({
    low, high, rounds, contextHash,
    midpoint: high - low > 1 ? Math.floor((low + high) / 2) : null,
    agreedCheckpointHash: agreed,
    claimantUpperHash: upper.claimant, challengerUpperHash: upper.challenger,
    waitingFor: high - low > 1 ? (["claimant", "challenger"] as const).filter((side) => !pending[side]) : [],
    isolated: high - low === 1,
    settlementEligible: false as const,
  });
  return {
    snapshot,
    submit(side: Side, opening: TraceOpening) {
      if (side !== "claimant" && side !== "challenger") throw new Error("invalid bisection side");
      if (high - low === 1) throw new Error("transition already isolated");
      if (pending[side]) throw new Error("side already opened this round");
      const midpoint = Math.floor((low + high) / 2);
      pending[side] = authenticate(side, opening, midpoint);
      if (pending.claimant && pending.challenger) {
        if (pending.claimant === pending.challenger) { low = midpoint; agreed = pending.claimant; }
        else { high = midpoint; upper = { claimant: pending.claimant, challenger: pending.challenger }; }
        pending = {};
        rounds++;
      }
      return snapshot();
    },
  };
}
