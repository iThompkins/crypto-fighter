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
Canonical input selection, conflicting signed packets, adoption of context and
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
The future signature/trace version must bind chain, arena, challenge, both main
wallets and delegated keys, match, complete rules/version and escrow terms before
play begins. No v1 root is accepted for settlement by this implementation.

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

The existing collision midpoint can produce half-unit x coordinates. Both
fighters start with matching fractional parts; movement changes x by integers,
collision separation gives both the same fractional part, and stage clamping
sets both to integers. Thus reachable x values remain multiples of one half.
Doubled encoding preserves the current rules; it does not change the simulation.
The future one-step verifier must preserve this exact arithmetic and transition
order. Serialization is not itself a proof that an arbitrary state is reachable.

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

## Required settlement/dispute state machine (not implemented)

1. Freeze escrow context and session delegations before signing inputs. Claims
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
   the two context-bound signed input packets, claimed post-state/checkpoint,
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

Freeze the escrow-bound protocol and canonical input/authentication rules first.
Then introduce claim/dispute storage, authenticated midpoint rounds, a minimal
Solidity transition verifier with differential tests against the unchanged game,
and authenticated turn timeouts. This document is not a claim those components
exist. No full-transcript on-chain replay fallback is permitted.
