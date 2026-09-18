# Execution trace and interactive disputes

## Architectural decision

The settlement direction is **optimistic Merkle-committed execution with interactive
bisection and a minimal on-chain transition verifier**. Solidity must not receive
or replay an entire match transcript. Full transcript validation is an off-chain
operation used to construct and independently check a claim's commitment.

An undisputed, properly formed claim can finalize after its challenge window.
A disputed claim must freeze result finalization while the dispute resolves.
This is an optimistic security model: a false claim can succeed if nobody with
the necessary data challenges in time. A Merkle root alone does not prove
execution or data availability. Monitoring, availability, response windows and
recovery are security requirements, not optional UI conveniences.

## Current implementation status

Genesis registration, one-time session authorization, immutable escrow binding,
context-authorized trace construction, an off-chain authenticated bisection
coordinator, and compact Solidity Merkle membership verification are now
implemented. See [GENESIS_AUTHORIZATION.md](GENESIS_AUTHORIZATION.md) for exact
formats, chain authority, lifecycle and tested limits. On-chain trace claims
and bisection turns/deadlines are implemented below.
Minimal transition adjudication is blocked on the reachable-coordinate encoding
defect documented under State encoding.
The sections below preserve the original design and experimental encoding; they
must not be read as claiming a complete settlement protocol.

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
this primitive increment, and browser settlement remains disabled.

The prior proposal's execution-acknowledgement mechanism was unresolved. It is
not silently treated as implemented or as a mandatory opponent co-signature
on the result. A legitimate winner must be able to claim without that signature.
Canonical input selection, conflicting signed packets, adoption of genesis and
availability must be specified before one-step verification can resolve them.

## Implemented experimental off-chain format

`src/execution-trace.ts` implements `experimental-offchain-trace-v1`, with CLI
`npm run commit-trace -- transcript.json [checkpoint-index]`. It clones the input
before asynchronous verification, accepts only complete terminal transcripts,
and always marks its output `settlementEligible: false`.
`npm run verify-trace -- transcript.json commitment.json` independently rebuilds
the off-chain trace and checks root, format, context, rules and terminal metadata;
checkpoint membership verification alone does not establish those facts.

This domain is deliberately distinct from the future escrow-bound protocol.
Its context hash commits match ID, full numeric rules/genesis hash with semantic revision,
both session addresses and public-key hashes. V1 packets do not sign this context.
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
the immutable cross-domain binding. Funded browser lifecycle integration remains
pending; practice games do not implicitly gain escrow authority.

## One canonical game version

There are no configurable per-match damage, timing, physics, or other combat
parameters. `src/protocol.ts` exports the fixed canonical version, immutable
legacy v1 metadata and canonical fingerprint. The fingerprint is computed once
from the canonical implementation's constants, semantic revision and initial
state, not from caller-supplied match settings. Its bytes are unchanged by this
clarification/refactor. It identifies a version for replay and compatibility.
A future global gameplay revision needs a new version/fingerprint; it is not a
new set of options that players negotiate at matchmaking.

The old transcript `rules` object remains only for v1 wire compatibility and must
exactly match the canonical values. It never drives simulation parameters. The
contract's `rulesHash` argument is retained as a version identifier, but only the
single canonical fingerprint is accepted. Escrow stake and response deadlines
remain escrow terms; they do not configure the game timer or physics.

All hashes use Keccak-256 of Solidity ABI encoding, not JSON. Domain tags are
`keccak256(UTF8("CryptoFighter:experimental-offchain-trace-v1:" + suffix))`.
Exact fields and types are defined by the exported encoder and builder.

### State encoding

State encodes, in fixed order: state domain, frame, remaining timer, terminal
boolean, outcome (0 pending, 1 P1, 2 P2, 3 tie), then P1 and P2 fighter arrays.
Each fighter is nine signed ABI words: x, y, width, height, HP, facing, cooldown,
active attack duration, vertical velocity. Geometric values and velocity are
multiplied by two; remaining fields are unscaled. Values must be exact safe
integers after scaling. No rounding is allowed.

**Known blocker (2026-09-17): this encoding is insufficient for reachable states.**
Independent movement clamping breaks the previously asserted equal-fraction
invariant. From genesis, 85 frames of masks (2,0) yield x=(544.5,572.5),
110 frames of (1,0) yield x=(0,572.5), and 55 frames of (2,1) yield
x=(272.25,300.25) at frame 250. Fifty idle frames then produce a valid terminal
tie. Strict signed transcript verification succeeds, but both trace builders
reject it because doubled quarter coordinates are not integers.

`test/trace-geometry-blocker.test.mjs` preserves the complete authenticated
reproduction. The single-transition implementation was withdrawn before commit
because it relied on the false invariant. Do not round these coordinates or
silently alter collision/clamping behavior. A new exact encoding/version and
its precision analysis require approval before implementing the verifier.
Merely changing the scale to four does not establish a general precision bound.

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

## Required settlement/dispute state machine (partially implemented)

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

## Next implementation boundary

The genesis binding, compact move authentication, trace claims and midpoint
turns/deadlines are implemented. Next resolve the state-encoding blocker above,
then implement the canonical single-transition verifier, authenticated timeout
resolution and adversarial end-to-end validation. No full-transcript on-chain
replay fallback is permitted. Replacement, equivocation, both-invalid and
non-response payout rules still require explicit decisions before settlement.

## On-chain turn implementation — 2026-09-17

`TraceDispute`, inherited by the arena, now accepts `claimTrace` only from an
activated escrow participant with no legacy claim/timeout. It fixes the root and
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
responders, bracket, round and deadline. All legacy settlement/timeout entries
reject a match once any trace claim exists, including an expired trace claim.

This stage intentionally locks local test deposits pending adjudication/recovery;
it is not a usable escrow lifecycle. Trace claims never transfer funds. Browser
settlement and real-money deployment remain disabled.
