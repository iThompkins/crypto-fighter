> Live dispute artifacts now use the [Phase C evidence-first pipeline](PHASE_C.md).
> Transcript-only builders below remain diagnostic primitives; they cannot detect omitted evidence.

> Current numeric status: Phase A v2 is documented in [FIXED_POINT_PROTOCOL.md](FIXED_POINT_PROTOCOL.md).
> Earlier dated implementation notes below describe historical milestones.

> The [protocol-boundary guide](PROTOCOL_BOUNDARY.md) is authoritative for
> current trace entry points, removed legacy methods, and unresolved policy.

# Execution trace and interactive disputes

## Architectural decision

The settlement direction is **optimistic Merkle-committed execution with interactive
bisection and a minimal on-chain transition verifier**. Solidity must not receive
or replay an entire match transcript. Full transcript validation is an off-chain
operation used to construct and independently check a claim's commitment.

A future settlement design may allow an undisputed claim to finalize after a
challenge window, but no such trace finalizer exists today. The current trace
path freezes its roots and can adjudicate one disputed transition; it cannot
move or release funds. A Merkle root alone does not prove execution or data
availability. Monitoring, availability, response windows, and recovery remain
security requirements, not optional UI conveniences.

## Current implementation status

Genesis registration, one-time session authorization, immutable escrow binding,
context-authorized trace construction, an off-chain authenticated bisection
coordinator, and compact Solidity Merkle membership verification are now
implemented. See [GENESIS_AUTHORIZATION.md](GENESIS_AUTHORIZATION.md) for exact
formats, chain authority, lifecycle and tested limits. On-chain trace claims,
bisection turns/deadlines, and neutral one-step adjudication are implemented below.
Phase A replaces the defective coordinate encoding with fixed-point v2.
Authenticated non-response recovery and trace settlement remain unimplemented.
The sections below describe the design and implementation boundaries; they do
not claim a complete settlement protocol. The exact API classification is in
[PROTOCOL_BOUNDARY.md](PROTOCOL_BOUNDARY.md#entry-point-classification).

## Repository inspection and reuse

At `7472d04`, the README already proposed canonical state encoding, authenticated
trace leaves, ordered Merkle roots, deadline-bound midpoint bisection and one-step
fraud proofs. Searches of tracked files and available Git history found no
implementation of those primitives. Historical matches were documentation and
references, not a reusable dispute implementation.

Preserve the cumulative `transition`, strict off-chain transcript verifier,
packet self/ack chains, frame chain and optimistic response-window concept.
Reuse the prior proposal's authenticated adjacent state/input commitments and
availability requirement. The existing continuation-packet dispute materially
conflicts: an F+1 signature pair does not prove an error at F. It must eventually
be replaced, not renamed as a fraud proof. The existing arbitrary claim/timeout
hashes are also insufficient. No replacement settlement code is introduced by
this primitive increment, and the browser sends no contract transaction.

The prior proposal's execution-acknowledgement mechanism was unresolved. It is
not silently treated as implemented or as a mandatory opponent co-signature
on the result. A legitimate winner must be able to claim without that signature.
Canonical input selection, conflicting signed packets, adoption of genesis and
availability must be specified before one-step verification can resolve them.

## Implemented experimental off-chain format

`src/execution-trace.ts` implements `fixed-point-trace-v2`, with CLI
`npm run commit-trace -- transcript.json [checkpoint-index]`. It clones the input
before asynchronous verification, accepts only complete terminal transcripts,
and always marks its output `settlementEligible: false`.
`npm run verify-trace -- transcript.json commitment.json` independently rebuilds
the off-chain trace and checks root, format, context, rules and terminal metadata;
checkpoint membership verification alone does not establish those facts.

This diagnostic context is deliberately distinct from the authorized trace context.
Its context hash commits match ID, full numeric rules/genesis hash with semantic revision,
both session addresses and public-key hashes. Compact move packets do not directly sign this context.
It cannot be upgraded to an escrow authorization by attaching a chain ID later.
The protocol authenticates a fresh random UUID-like genesis ID
against its immutable escrow record once, before play. That binding identifies
chain, arena, challenge, main-wallet participants, delegated session keys,
canonical protocol version and escrow terms. Authenticated genesis/session
adoption must prevent reusing a nonce or signed history in another escrow,
including another chain or contract; a local lookup or bare nonce is insufficient.
Subsequent move signatures may bind that genesis ID and their chained move fields
without redundantly carrying every escrow field. No per-move repetition of the
full context is required when the genesis binding is sound.

Current live `makeMatchId()` generates a fresh random 256-bit bytes32 ID, which
serves the intended UUID-like role. First and later move digests include this ID;
zero previous hashes are sentinels, not a shared match identity. The deterministic
sample generator deliberately uses a fixed fixture ID and is not matchmaking.
The arena now enforces unique registration and both session authorizations over
the immutable cross-domain binding. The [Phase B browser lifecycle](PHASE_B.md) requires explicit local escrow
authorization; practice games do not implicitly gain escrow authority.

## One canonical game version

There are no configurable per-match damage, timing, physics, or other combat
parameters. `src/protocol.ts` exports the fixed canonical version, immutable
v2 metadata and canonical fingerprint. The fingerprint is computed once
from the canonical implementation's constants, semantic revision and initial
state, not from caller-supplied match settings. Phase A replaces its bytes with the v2 fingerprint. It identifies a version for replay and compatibility.
A future global gameplay revision needs a new version/fingerprint; it is not a
new set of options that players negotiate at matchmaking.

The old transcript `rules` object remains as descriptive metadata and must
exactly match the canonical values. It never drives simulation parameters. The
contract's `rulesHash` argument is retained as a version identifier, but only the
single canonical fingerprint is accepted. Escrow stake and response deadlines
remain escrow terms; they do not configure the game timer or physics.

All hashes use Keccak-256 of Solidity ABI encoding, not JSON. Domain tags are
`keccak256(UTF8("CryptoFighter:fixed-point-trace-v2:" + suffix))`.
Exact fields and types are defined by the exported encoder and builder.

### State encoding

Phase A uses the [fixed-point v2 numeric protocol](FIXED_POINT_PROTOCOL.md).
State encodes a domain, uint16 frame/timer, bool terminal, uint8 outcome, and two
seven-field fighter tuples (x,y,vy,hp,facing,cooldown,active). Coordinates and
velocity are raw SCALE=256 integers; dimensions are compiled rules constants.
Transcript final-state hashes use these same bytes. Encoding never rounds.

The former half-unit codec rejected valid quarter-unit histories. The subsequent
2^-48 analysis describes retired binary64 behavior, not current physics. V2
intentionally replaces that behavior with nearest integer midpoints, ties to even.
The authenticated wall/recollision regression now successfully commits. Old roots,
fingerprints and transcript versions are not compatible.

### Checkpoints, leaves and padding

A checkpoint hashes a domain plus six bytes32 values: encoded state hash,
canonical frame head, P1/P2 packet heads, and previous P1/P2 packet heads. The
previous heads let a future single-step verifier check F-2 acknowledgements from
an agreed F-1 checkpoint, without fetching earlier transcript history.

Checkpoint 0 is genesis with zero chain heads. Checkpoint F is the state and
heads after canonical frame F. For a terminal frame L, checkpoints L through
300 are identical absorbing checkpoints. This is commitment normalization for a
common dispute horizon, not execution of post-terminal input packets. Delayed
unused packets are verified off-chain but excluded from the commitment.

A leaf is `H(leafDomain, contextHash, uint256 index, checkpointHash)`.
Positions 0..300 represent checkpoints. Positions 301..511 are distinct padding
hashes `H(paddingDomain, contextHash, uint256 index)`; they cannot be opened as
execution checkpoints. A parent is `H(nodeDomain, left, right)` with ordered
children, never sorted pairs. The tree has 512 leaves and depth 9. Membership
verification requires an index 0..300 and exactly nine sibling hashes.

Two adjacent checkpoint openings bind the pre/post states, two input hashes and
frame-chain update from the README's original transition-leaf proposal. The
checkpoint representation additionally supports direct midpoint state openings.
A membership proof proves inclusion only, not correctness of the state or root.
The root, context, final frame and terminal state must be checked against locally
rebuilt output when importing a claim.

## Historical target settlement/dispute state machine

The list below records design requirements accumulated during implementation.
Implemented trace steps stop at neutral adjudication. Payout, non-response, and
availability consequences remain proposals owned by Issues #4 and #5, not
current behavior.

1. Authenticate the unique genesis-to-escrow binding and session delegations before signing inputs. Claims
   bind root, format/rules/context, terminal frame, encoded terminal state and
   outcome. Authenticate genesis and terminal endpoint membership with bounded
   proofs. Terminal outcome/frame fields must match the revealed terminal state.
2. An opponent disputes within the inclusive result window. Freeze ordinary
   result finalization and commit the opponent's alternative root under the same
   context and comparison horizon. Authenticate equal genesis checkpoints and
   unequal endpoint checkpoints; reject arbitrary unauthenticated endpoints.
3. Maintain an agreed lower checkpoint and disputed upper checkpoint. At each
   round both sides reveal their committed checkpoint at the contract-selected
   midpoint, with membership proofs against their fixed roots. Equal checkpoints
   move the lower bound up; unequal checkpoints move the upper bound down. Both
   responses must be authenticated before updating the bracket. At most nine
   rounds isolate adjacent indices for the 300-transition horizon.
4. With adjacent endpoints, reveal the agreed pre-state and checkpoint fields,
   the two genesis-bound signed input packets, claimed post-state/checkpoint,
   and bounded membership proofs. Verify exactly that one deterministic
   transition and its packet/self/ack/frame-chain updates. For an already
   terminal pre-state, the sole valid normalized step preserves the checkpoint
   and consumes no new packet. Full histories are never calldata requirements.
5. Bisection locates an inconsistent transition after an agreed lower endpoint;
   midpoint equality alone does not prove all earlier internal states were valid.
   In particular, arbitrary fraudulent traces can diverge and reconverge. The
   adjudication invariant must establish one decisive invalid step rather than
   claim that binary search proves a globally earliest historical mismatch.
6. A successful fraud proof invalidates the false result; it must not automatically
   certify every other state of a challenger's trace. Supported replacement
   outcome, slashing, mutual invalid claims and equivocation require explicit
   rules and tests. Preserve current combat and tie-refund rules unless approved.
7. Every active turn records who owes a response and a deadline. Invalid openings
   do not count as a response or restart the clock. Timeout resolution must rely
   on that authenticated state, not invented transcript hashes. Prohibit overlapping
   ordinary claims, gameplay timeout claims and dispute games. Enforce result and
   dispute deadline boundaries consistently and pay at most once.
8. Require availability of the commitment data and needed openings throughout the
   challenge and dispute windows. Specify missing data, non-response, disconnect,
   key loss, cancellation and recovery before enabling funds. A commitment without
   a way for an honest opponent to retrieve dispute evidence is insufficient.

## Remaining implementation and policy boundary

Genesis authorization helpers, trace claims and midpoint turns/deadlines are
implemented. Phase A state-encoding migration and Phase B authenticated live
lifecycle/input chains, reconnect, and durable public evidence are in place; see
[Phase B](PHASE_B.md) for the exact trust and recovery boundaries.
Single-transition adjudication now consumes those Phase B/C guarantees. No
full-transcript on-chain replay fallback is permitted. Settlement integration,
claim replacement, both-invalid consequences, availability failure, and
non-response payout rules still require explicit decisions before settlement.

## On-chain turn implementation — 2026-09-17

`TraceDispute`, inherited by the arena, accepts `claimTrace` only from an
activated escrow participant. It fixes the root and
binding context, proves the canonical genesis and index-300 endpoint, and binds
terminal frame/outcome to the revealed ABI state. Terminal execution and absorbing
normalization remain optimistic. There is deliberately no trace payout entry point.

Only the opponent may `challengeTrace`, through the inclusive claim deadline,
with another fixed root, the same canonical genesis, and an unequal endpoint.
Both participants owe `revealMidpoint` at the selected floor((low+high)/2), in
either order, under one shared deadline. Explicit round numbers prevent stale
transaction replay. Invalid/duplicate/late responses cannot alter the clock or
bracket. Both valid responses advance equal(low)/unequal(high); adjacency stops
midpoint turns after at most nine rounds. Events and `getTraceGame` expose roots,
responders, bracket, round and deadline. The legacy settlement/timeout entries
described by this dated milestone were removed in Issue #9.

This stage intentionally locks local test deposits pending adjudication/recovery;
it is not a usable escrow lifecycle. Trace claims never transfer funds. Browser
contract transactions in the browser and real-money deployment remain disabled.

## Neutral one-step implementation — 2026-10-01

`GameTransitionVerifier` independently implements the v2 integer transition,
state bounds, ties-to-even collision separation, jump/gravity, cumulative attack
damage, timer/KO outcome, and terminal absorption. It validates both packet
signatures against the escrow-delegated session keys, exact match/slot/frame,
self chains, F-2 acknowledgement chains, input masks, and canonical frame-head
update. It returns the canonical state and checkpoint hashes for one step.

The arena deploys this pure verifier as a separate immutable contract. That keeps
`CryptoFighterArena` below the EIP-170 runtime limit without relaxing local EVM
deployment checks. At an adjacent bracket, `adjudicateStep` reopens the agreed
pre-checkpoint under the claimant root and both disputed post-checkpoints under
their fixed roots. It authenticates the supplied pre-state, executes the step,
and records `Claimant`, `Challenger`, or `Neither`. A terminal pre-state consumes
no packet and must preserve the entire checkpoint. No verdict transfers funds,
changes reputation, or certifies the rest of either trace.

Objective signed invalid-input and same-slot/frame equivocation proofs are
recorded separately from execution disagreement and have no automatic consequence.
Participants may bind a root to the Phase C `journalHash`; this detects a changed
retrieved archive but does not prove delivery. `src/onchain-dispute.ts` rebuilds
independently authorized Phase C bundles and prepares exact claim, midpoint, and
adjudication tuples. The browser exposes calldata preparation in developer mode
and still sends no settlement transaction.
