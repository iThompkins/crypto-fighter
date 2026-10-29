# Phase B: authenticated live matches and durable evidence

The live browser uses `LiveMatch` for lifecycle admission, input authentication,
chain validation, signing, and replay. PeerJS transports untrusted values;
`App.tsx` does not maintain a second input-admission implementation. Settlement
transactions remain disabled. No reputation, forfeiture, payout, or timeout
economics are introduced here.

## Policy boundary

Keep three categories separate in subsequent phases:

1. Objectively verifiable protocol faults, including invalid authentication,
   contradictory signed statements, invalid proofs, and invalid transitions.
   Invalid authentication alone does not attribute a message to a player.
2. Liveness conditions, including missing packets, disconnections, and stalls.
   They need recovery and deterministic eventual escape, not automatic cheating
   labels or winner assignment.
3. Behavioral/product concerns such as reliability, abandonment patterns, and
   sportsmanship. Later reputation, matchmaking, or governance may address them.

Every funded protocol must have a tested objective eventual escape from **every**
reachable escrow state, including unavailable evidence and unresolved disputes,
without cooperation from an absent player. Unactivated-match refunds alone do
not establish that property. Phase B does not implement this economics policy;
funding and settlement remain disabled in the browser.

## Live lifecycle

- **Discovery:** transport connection alone has no match authority. Each new
  connection supplies a fresh random challenge. The peer signs a domain-separated
  HELLO containing that challenge, its public key, slot, and genesis identifier.
  Schema, challenge, signature, expected slot, and pinned identity must match.
- **Prepared:** an immutable descriptor pins the mode, canonical rules, genesis,
  and both session public keys. The host's signed READY authenticates its offer
  before the joiner creates authoritative state. Both participants durably commit
  their signed READY statements before inputs become admissible.
- **Running:** both readiness statements are present; the connection is admitted.
  Only recursively valid, committed input pairs advance the simulation.
- **Disconnected:** local signing/advancement pauses. The same in-memory session
  can authenticate a replacement transport and recover committed history.
- **Complete:** the canonical simulation reaches its terminal state. This is a
  game result, not escrow adjudication. Late equivocation is still retained.
- **Conflict:** two authenticated different statements for the same slot/frame
  pause the match. Neither player is automatically declared the winner.
- **Storage-failed:** failed durable commit stops further authority. No uncommitted
  outgoing packet is released, and no uncommitted incoming packet is acknowledged.
- **Closed:** local reset/unmount invalidates work and destroys controller signing
  authority. Reset closes the connection and creates fresh keys/genesis; it is
  never a remote instruction to erase or retarget a match.
- **Inspection:** recovery revalidates stored evidence and reconstructs gameplay
  without a signing key. It cannot transition back to running.

Missing or mismatched dependencies stall executable input admission while
retaining authenticated observations. A chain mismatch against currently seen
packets is not, by itself, a complete adjudication proof. Dependencies on an
unknown equivocation branch may require more evidence.

`READY` is the only state-changing signed lifecycle command. It is idempotent,
slot-bound, and domain-separated by the immutable descriptor. Legacy unsigned
START_MATCH/RESET_MATCH messages are rejected. Signed REQUEST messages are
read-only retransmission hints, not acknowledgements or dispute deadlines; they
are not journaled. Signed inputs carry the durable self-chain and delayed opponent
acknowledgements. Fresh transport challenges are ephemeral admission checks;
the signed readiness statements preserve mutual match consent.

## Practice and escrow authentication

Practice uses a separate descriptor hash domain. Discovery proves possession of
session keys and pins them for that session; it does not establish a main-wallet
identity or escrow authorization.

For an escrow-authorized match, the user connects their main wallet and explicitly
selects an arena/challenge. The browser reads the genesis binding and registration
from that provider at one block. It checks chain, arena, challenge, canonical rules,
main-wallet participant, session delegation, both authorization signatures, and
activated status. The lookup locator and block number are preserved. A peer offer
cannot switch a practice client into escrow mode; the same authorization must
already have been loaded and verified locally.

`Export genesis consent` produces a signature for the locally read binding without
sending a transaction. Its public preparation record is committed before download
and can be inspected after reload in a separate `consent:` journal. Adoption is locked for the lifetime of the ephemeral key.
`Load activated escrow match` verifies a previously activated binding. Deployment,
funding, and activation transactions are deliberately not supplied by this UI.
A key that has adopted an escrow binding cannot fall back into practice. A reload
creates a new key, so an old delegation cannot silently authorize it.

## Admission, ordering, and recovery

Exact runtime schemas reject unknown fields and malformed scalar values before
cryptography or state changes. Connection and controller generation counters
invalidate queued callbacks and asynchronous completions on replacement/reset.
Admission and signing are serialized. The collector handles duplicate detection,
retains two conflict variants per slot/frame, and recursively validates both
self-chain and delayed opponent-chain dependencies.

The bounded receive window is the current simulation frame plus INPUT_DELAY + 2.
Old-frame packets still pass authentication so late conflicts survive. The wire
limit is 16 KB and the per-connection callback queue is capped at 128. Local
connection observations are capped at 1024 per journal. Resource limits never
assign blame or change outcomes.

Missing inputs produce signed requests every 500 ms while running. Replies contain
only already committed local packets. Reconnect replays readiness and a bounded
recent packet tail; requests recover older gaps. Requests and retries do not
resign inputs. An in-memory signing reservation prevents a disconnect during
signing/commit from causing a different input to be signed for that same frame.
When transport replacement interrupts a successful commit, reconnect reconciles
committed rows into the collector before restoring connectivity. A conflict written
during that interval therefore still halts play.

## Persistence model

`BrowserEvidenceStore` uses IndexedDB with strict-durability read/write
transactions. The commit boundary is transaction completion, not request success.
Initialization checks and writes atomically, preventing two tabs from acquiring
the same local journal. Journals are keyed by descriptor hash and local slot, so
two players on the same origin keep independent histories.

The append journal contains:

- immutable descriptor, session identities, and (for escrow) genesis authorization
  plus the independently read record and lookup provenance;
- both signed readiness statements;
- every retained authenticated signed input, including delayed tail packets,
  chained acknowledgements, and both statements proving a conflict;
- bounded local disconnect/reconnect observations with untrusted local timestamps.

Outgoing statements commit before send. Incoming statements commit before
simulation use or dependent local signing. A crash after commit but before send
leaves reconstructible evidence. Duplicates are idempotent; interrupted-generation
retries may leave identical journal rows, which recovery deduplicates. A failed
write stops the controller rather than claiming the data is safely committed.

No private key, signer handle, or resumable authority flag is stored. Recovery
rechecks schemas/signatures/chains and rebuilds uncontested canonical frames from
the public journal. Conflicting histories remain inspection evidence with an
explicit halt reason rather than a certified replay result. Persisted genesis records are historical inspection evidence, never a new
trusted live-chain lookup. Saved evidence can be downloaded after reload. Recovery
may reconstruct more committed frames than had been rendered before a crash.

IndexedDB is local storage, not a data-availability service. The guarantee covers
browser reload/crash under the browser's transaction durability semantics, not
user deletion, origin compromise, eviction, disk loss, or malicious storage edits.
Invalid recovered evidence is rejected. Exported copies remain useful backups.

## Later-phase assumptions

Phase C/D consume these authenticated evidence and ordering guarantees; canonical
reconstruction and neutral minimal-step execution are now implemented. Later work
must resolve availability and result-replacement rules and test objective exits from every
funded state before enabling settlement. Historical activation evidence does not
replace fresh chain checks for any future settlement action. RPC trust/finality,
chain reorganization handling, durable external availability, and escrow policy
remain explicit integration assumptions. Local disconnect timing never proves
cheating or authorizes forfeiture.

The required evidence inventory, availability failure taxonomy, chain-finality
boundary, and reorganization behavior are now specified in
[`EVIDENCE_AND_CHAIN_TRUST.md`](EVIDENCE_AND_CHAIN_TRUST.md). The current browser
does not implement that document's production delivery or chain-trust profile.

## Completion validation

Phase B passed 92 Node tests, 43 contract tests, and 5 browser tests, plus build,
lint, and diff checks. Browser escrow testing uses a fixture EIP-1193 provider;
the contract suite independently tests actual EVM genesis activation. The suite
covers stale generations, duplicate/reordered/missing inputs, retransmission,
late equivocation, interrupted commits, disconnect/reconnect, reload inspection,
key loss, practice/escrow separation, and overlapping local preparation actions.

Phase C adds the [canonical evidence-to-transcript-to-trace pipeline](PHASE_C.md).
Browser transcript and saved-evidence exports now use committed journals directly;
UI snapshots and recovered controller state do not select a trace branch.
