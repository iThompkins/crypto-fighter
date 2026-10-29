# Evidence availability and chain trust

This document specifies the evidence and chain-observation boundary that any
future Crypto Fighter settlement protocol must satisfy. It does not add an
archive service, RPC policy implementation, contract timeout, or economic
consequence.

The current local prototype can authenticate supplied evidence, reconstruct a
complete trace, and adjudicate one isolated transition. It cannot prove that
another party obtained an archive, that omitted evidence does not exist, or that
one RPC response represents a final canonical chain. Those are different
properties and must remain different protocol states.

## Start here: the plain-English version

A browser does not usually read a blockchain by itself. It asks an **RPC
provider**—a server that answers questions such as “what is the current block?”
or “was this match activated?” The answer is still one server's report. That
server may be behind, misconfigured, dishonest, or following recent history that
the network later replaces.

That is what **“a single RPC is not economic finality”** means:

> Do not release, forfeit, or refund money only because one blockchain server
> says an event happened.

Recent blocks can occasionally be replaced by a **reorganization** (“reorg”). A
transaction visible now may disappear from the accepted history. Before money
depends on an event, the application needs a written rule for deciding when that
event is settled enough to rely on.

### Terms used below

| Term | Plain meaning |
| --- | --- |
| RPC provider | A server the application asks for blockchain data. MetaMask's configured network endpoint is one example. |
| Confirmation | Another block has been built after the block containing the transaction. More confirmations generally mean more history would need to be replaced to remove it. |
| Finalized block/tag | Some networks explicitly identify an older block that their consensus rules consider final except under an extreme failure. A node's `finalized` query asks for that block instead of the newest block. |
| Confirmation depth | A chosen number of later blocks to wait when the network does not provide a suitable finalized-block signal. This number must be chosen for that specific network; it is not universal. |
| Reorg monitoring | Remember the block hash and keep checking that it remains in the accepted chain. If it disappears, pause and rebuild state from the new history. |
| Deployment profile | A short rulebook for one specific network: expected arena address/code, acceptable RPC sources, what counts as sufficiently final, and what to do after a reorg. It is not a Solidity feature. |
| Economic finality | The point at which the application's reviewed rule says an event is settled enough to let it affect money. |

So the dense sentence “a deployment profile must choose either a trustworthy
protocol-level finalized tag or an explicit confirmation depth plus reorg
monitoring” means:

- On a network with a usable finalized-block signal, wait until the match action
  is included in that finalized history, and corroborate it independently.
- Otherwise, choose and document how many later blocks to wait, remember the
  relevant block hashes, and keep checking for replacement history.
- If the sources disagree or the transaction is replaced, pause. Re-read the
  contract instead of guessing who should receive money.

This specification deliberately does not invent a confirmation number because
Crypto Fighter has not selected a production network. “Wait 12 blocks,” for
example, could be reasonable on one network and dangerously wrong on another.

## Worked examples

### Example 1: two RPC providers disagree about match activation

Alice's wallet provider says challenge 7 is activated. A separately operated
provider says the activation transaction is missing because it is viewing a
different chain tip.

- The UI may show “activation uncertain.”
- Alice must not start escrow play or treat the match as funded and authoritative.
- The state is `retryable-uncertainty`, not “Alice wins,” “Bob wins,” or “bad
  evidence.”
- After the providers converge and the activation satisfies the network's
  written finality rule, the browser can read the binding again and continue.

### Example 2: a dispute transaction is reorganized out

Bob sees his trace challenge mined and a midpoint deadline appears. Two blocks
later, the network replaces those blocks and the accepted chain no longer
contains Bob's challenge.

- The old midpoint deadline no longer controls anything.
- Both clients pause and reload the arena's trace state from the accepted chain.
- Bob may resubmit only if the claim is still challengeable.
- Nobody loses for missing a deadline that existed only on the discarded fork.

### Example 3: a hash exists, but the archive does not arrive

Alice publishes `journalHash = 0x123…`. Bob cannot download the journal file.

- The hash would let Bob detect a changed file **if he received one**.
- The hash cannot reconstruct or deliver the missing file.
- This is unavailable evidence. It does not prove Alice's trace correct or
  incorrect.
- A future settlement rule must define Alice's delivery obligation, its deadline,
  and the safe fund exit if she does not deliver. Issue #4 owns that consequence.

### Example 4: the delivered archive has the wrong hash

Bob receives a file, but its computed hash is not Alice's committed
`journalHash`.

- The file fails integrity checking and is rejected.
- Alice may deliver the correct file while the delivery window remains open.
- If an explicitly defined delivery deadline expires, that becomes
  non-response. It still does not automatically prove a gameplay winner.

## Normative safety rules

1. **Authenticity, integrity, availability, and chain inclusion are separate.**
   Passing one check never implies the others.
2. **Missing is not invalid.** Failure to obtain bytes is an availability or
   response failure, not proof that the absent bytes are false or fraudulent.
3. **Local possession is not delivery.** IndexedDB durability and a local export
   do not prove that an opponent, watcher, or adjudicator can retrieve the data.
4. **A commitment is not availability.** `journalHash`, a trace root, and
   `publishTraceArchive` detect substitution after retrieval; they do not deliver
   the committed preimage.
5. **A single RPC is not economic finality.** One provider may supply a “pending”
   display or support local development. Its answer alone must not release,
   forfeit, or refund money or establish a money-governing deadline.
6. **Unfinalized observations are tentative.** Derived admission, deadlines,
   roots, and verdicts must be recomputed after a reorganization.
7. **Uncertainty fails closed economically.** Provider disagreement, an unknown
   canonical block, or unavailable required evidence cannot default to paying
   either player.
8. **Every required response must be constructible without live cooperation.** A
   participant who retained the required package must be able to answer after
   disconnect, reload, or peer disappearance.
9. **Liveness policy may act on an objectively missed obligation, not inferred
   intent.** Non-response can eventually select a funded-state exit only after
   Issue #4 defines the obligation, delivery preconditions, clock, caller, and
   fund destination.

## Four properties that must not be collapsed

| Property | Question | Current check | What it does not establish |
| --- | --- | --- | --- |
| Authenticity | Who signed this statement? | Domain-separated signature recovery against the delegated session key. | Execution, completeness, delivery, or honesty. |
| Integrity | Are these the exact committed bytes? | Canonical hashes, packet chains, `journalHash`, trace roots, and Merkle openings. | That anyone else possesses the bytes or that omitted bytes do not exist. |
| Availability | Can the obligated party obtain all required bytes before its deadline? | Local IndexedDB/export only; no protocol-level delivery proof. | Canonical-chain inclusion or validity of the contents. |
| Chain inclusion/finality | Did the canonical chain include this state or action deeply enough to rely on it? | `readGenesisRecord` pins one provider read to one block; receipts/events expose later actions. | Provider honesty, canonical finality, or reorg immunity. |

## Evidence inventory and responsibility

All artifacts below are public protocol evidence. Private session keys and
resumable signing authority are never evidence and must not be archived.

| Evidence item | Named source | Integrity/authenticity check | Availability expectation and retention owner |
| --- | --- | --- | --- |
| Deployment identity and canonical rules hash | Deployment configuration plus arena bytecode/constants | Expected chain ID, arena address, code identity, and `CANONICAL_RULES_HASH` | Every participant and watcher must pin the intended deployment for the whole match and dispute lifetime. Production code-identity policy is unresolved. |
| Genesis locator and registration | Canonical chain: chain, arena, challenge ID, `challengeForGenesis` | One-block domain and registration checks in `readGenesisRecord` | Both participants retain the locator and independently reproducible block reference. A saved response is historical evidence, not fresh authority. |
| Completed `GenesisBinding` and activation | Canonical arena state | Binding hash, both session authorization signatures, registered genesis, and authorized flag | Both participants retain the binding/signatures. Economic use requires a fresh chain read confirmed under the network-specific rule, not only an embedded record. |
| Signed READY statements | Each delegated session | Exact schema, mode-bound lifecycle digest, slot, signer, and immutable descriptor | Each participant retains both statements before gameplay. Missing READY makes reconstruction incomplete. |
| Signed input packets and acknowledgements | Each delegated session through the live journal | Signature, match/slot/frame/mask, self-chain, and delayed opponent-chain checks | Each participant retains every sent and received distinct signed statement, including tails and conflicts, before relying on it. |
| Complete public journal | `BrowserEvidenceStore` / exported `phase-b-journal-v1` | Strict schema, canonical reconstruction, `journalHash` | Each participant owns at least one durable copy. A future funded protocol requires externally retrievable replication before obligations begin; mechanism is unresolved. |
| Phase C dispute bundle | Deterministic rebuild from the complete journal and authoritative record | Rebuild and compare every derived field; verify `evidenceHash`, transcript/state hashes, trace root, and all openings | Each participant must be able to regenerate it from retained source evidence. Derived bundles do not replace the journal. |
| Trace root and archive commitment | Participant transaction through `claimTrace` / `publishTraceArchive` | Canonical-chain transaction, participant identity, root, and immutable root-to-`journalHash` mapping | The publisher is responsible for serving the exact committed archive. The on-chain hash is only an integrity locator. |
| Midpoint and endpoint openings | Deterministic Merkle tree for one fixed root; submitted openings also appear in public transaction calldata | Ordered proof, context, index, checkpoint hash, and fixed depth | A responder needs its own full tree for its root. A caller submitting both parties' final openings must retrieve the opponent's previously submitted opening from canonical calldata, an indexed archive, or another explicit delivery path; the current client does not automate that retrieval. |
| Isolated-step witness | Complete evidence plus both fixed roots/openings | Agreed pre-state, both packets or terminal absorption, packet chains, signatures, and root-specific upper openings | Must be reconstructible after peer loss. Submitted openings are public calldata, but the current client does not guarantee or automate their retrieval. |
| Objective fault witness | One signed invalid-input packet or two distinct same-slot/frame packets | Arena recovers the delegated signer and checks the fault predicate | Anyone retaining the signed bytes can submit it. No full journal is required, but retention through final resolution is required. |
| Dispute state, deadlines, and verdict | Canonical arena state and transaction receipts/events | Correct deployment, canonical block ancestry, state getter/event consistency, and finality policy | All participants/watchers monitor through final resolution. A local timer or peer observation is not a chain deadline. |

### Retention floor

For a future funded match, both participants must retain the complete source
journal, binding/authorization, and all dispute derivations until the later of:

- final settlement plus the deployment's reorg-safety period; or
- expiry of every claim, challenge, appeal, and evidence-fault window.

The publisher of a root must additionally keep the exact archive committed by
its `journalHash` retrievable for that period. Exact duration, replication count,
service-level objective, and deletion policy remain open because no production
chain or delivery system has been selected. In the current prototype there is no
final settlement, so evidence should be treated as inspection data retained until
the user explicitly accepts that deleting it destroys future defense capability.

## Minimum evidence by dispute action

“Win” below means obtain the current neutral technical verdict. No current action
authorizes payout, forfeiture, or reputation change.

| Action | Minimum local material | Required chain observation | Result if material is unavailable |
| --- | --- | --- | --- |
| Enter escrow mode | Locator, complete binding, both authorization signatures, delegated key identity | Finality-qualified registration and activated binding | Do not admit escrow mode or sign READY/input. The current single-provider browser lookup is local-only and not production-qualified. |
| Publish archive commitment | Complete exact journal, derived root, `journalHash` | Active authorized match and participant account | Do not publish a hash for an archive the publisher cannot retain and serve. |
| Open `claimTrace` | Complete uncontested journal/bundle, authoritative record, root, genesis opening, fixed-horizon endpoint opening, terminal state | Active authorized match with no existing trace game | No valid claim can be constructed. Incomplete/conflicting evidence is not silently normalized. |
| Open `challengeTrace` | Challenger's complete bundle/root, same authorized context and genesis, unequal endpoint opening | Canonical claim root and still-open claim deadline | Lack of bytes is availability failure. If future policy names a party as obligated to challenge, expiry without its transaction is non-response; neither condition proves the claimant trace correct. |
| Answer a midpoint | Full tree for the responder's already fixed root and the selected round/index | Canonical bracket, round, responder bit, and deadline | If no valid opening is submitted in time, classify non-response; Issue #4 must define the fund-safe consequence. |
| Adjudicate isolated step | Agreed pre-opening/state, both fixed upper openings, and for a nonterminal step both signed inputs with required chain links | Canonical adjacent bracket, both fixed roots, participants, and deadline | Missing opponent opening or packet is unavailable evidence, not a `Neither` execution verdict. `Neither` applies only after a complete well-formed witness executes and matches neither root. |
| Prove invalid input/equivocation | The signed packet or signed conflicting pair | Finality-qualified binding/session delegation and active evidence context | Without signed bytes there is no objective fault proof. Local suspicion or disconnect is insufficient. |
| Rely on a verdict economically | Complete final dispute record and settlement preconditions | Finality-qualified adjudication and later settlement transaction | Not implemented. Issue #4 must define timing and destination; no off-chain actor may improvise. |

## Threat and assumption matrix

| Threat or condition | Detectable fact | Classification | Required behavior |
| --- | --- | --- | --- |
| Browser database deletion, eviction, disk loss, or lost export | Required local rows cannot be read | Unavailable evidence, locally caused or unattributed | Stop claiming defense readiness. Do not manufacture a trace or label the opponent at fault. Use the future funded-state exit defined by Issue #4. |
| Opponent withholds its committed archive or required opening | Authenticated delivery obligation expires without the exact bytes/proof | Non-response with an availability cause | Preserve the commitment and delivery attempt. Apply only a pre-specified non-response exit; do not call the hidden evidence invalid. |
| Only one party has a complete archive | One party can rebuild; the other cannot | Asymmetric availability | The possessing party may submit verifiable material. Economic policy must not assume symmetry and must still provide an objective exit for the other party. |
| Partial archive or missing dependency | Reconstruction reports missing READY/input/dependency | Incomplete evidence | Request/retrieve missing bytes while time remains. It cannot open a valid trace and is not equivalent to a both-invalid execution result. |
| Corrupted or substituted archive | Canonical parsing/hash/reconstruction fails or `journalHash` differs | Invalid delivery/integrity failure | Reject the delivered bytes. Permit correct redelivery before the deadline; otherwise the obligation ends as non-response. Attribute fraud only if signed evidence proves it. |
| Malformed or forged statement | Schema/signature fails | Unauthenticated/invalid evidence | Reject without attributing it to a player. |
| Two authenticated statements for one slot/frame | Both signatures and conflict predicate verify | Objective equivocation evidence | Preserve both; no branch selection. Consequence remains an Issue #4 policy choice. |
| Authenticated invalid input mask | Signature and invalid-mask predicate verify | Objective invalid-input evidence | Preserve and submit independently of the full trace. Consequence remains an Issue #4 policy choice. |
| Valid complete witness matches neither upper root | One-step execution succeeds but neither commitment matches | `StepVerdict.Neither` | Treat as an execution result, distinct from missing/unavailable evidence. Issue #4 defines fund movement. |
| Single RPC lies, is stale, censors, or serves the wrong fork | Cross-check disagreement, implausible ancestry/code, stale head, or unavailable corroboration | Retryable chain uncertainty; possibly provider failure | Pause authority and economic reliance, switch/cross-check providers, and wait for finality. Never select a winner from the response. |
| Insufficient confirmations | Transaction exists only in a non-final block | Tentative chain state | Do not begin an irreversible dependent phase. Continue monitoring and recompute if displaced. |
| Chain reorganization | Previously observed block is no longer canonical | Rollback/recompute event | Follow the reorg rules below. A displaced deadline or verdict has no authority on the new canonical history. |
| Participant sends no required transaction despite available evidence | Canonical deadline passes without its valid action | Non-response | Use only the explicitly specified Issue #4 exit. Silence is not automatically cheating. |

## Failure taxonomy consumed by settlement

Issue #4 must use these distinct inputs rather than one generic “bad dispute”:

| Category | Objective condition | May it directly imply an execution verdict? |
| --- | --- | --- |
| `invalid-evidence` | Supplied bytes fail schema, signature, commitment, proof, or chain checks. | No. Reject the item; attribute only when a valid signature/fault proof permits it. |
| `objective-fault` | A contract-verifiable signed invalid input or equivocation predicate succeeds. | No. It is a separate fact whose economic consequence is unresolved. |
| `unavailable-evidence` | Required bytes cannot be retrieved or possessed. | No. Absence cannot become `Neither` or validate the other root. |
| `non-response` | A named actor fails to submit a valid required action by a canonical deadline after delivery preconditions were satisfied. | No. It is a liveness outcome for Issue #4 to map to an exit. |
| `retryable-uncertainty` | Canonical chain, finality, provider agreement, or delivery status cannot yet be determined. | No. Pause/retry; it must not trigger irreversible value movement. |
| `incomplete-trace` | Supplied authentic journal lacks readiness, execution input, or a required dependency. | No. It cannot be promoted to a trace claim. |
| `conflicting-evidence` | Multiple authenticated payloads exist for one slot/frame. | No selected trace. Preserve objective conflict evidence. |
| `claimant`, `challenger`, `neither` | A complete isolated-step witness executes and matches the claimant upper root, challenger upper root, or neither. | Yes, but only for that isolated step. Economic meaning remains unresolved. |

Unavailable evidence and non-response may coexist: unavailability describes the
missing prerequisite; non-response describes the missed on-chain obligation.
They may share a future exit only if Issue #4 explicitly justifies that policy.

## Chain trust and finality by lifecycle stage

No production network is selected, so this document cannot responsibly say
“wait N blocks.” Before deployment, the team must write the network-specific
rulebook described above. It must answer:

1. Which chain, arena address, and deployed code are expected?
2. Which independent sources are allowed to report chain state?
3. Does this network provide a suitable finalized-block signal? If so, how is it
   checked? If not, exactly how many later blocks must be observed?
4. Which block hashes are retained and monitored for replacement?
5. What pauses, rolls back, or escalates when the sources disagree or a reorg is
   deeper than expected?

In the table, “confirmed” means the event passed that written rule. It does not
mean merely “one RPC returned a transaction receipt.”

| Stage | Minimum observation policy | If not final or providers disagree |
| --- | --- | --- |
| Challenge discovery and UI preview | One provider may show tentative data, clearly non-authoritative. Verify chain, code/deployment identity, arena, challenge, and block ancestry before use. | Keep it provisional; do not sign adoption or start an economic clock. |
| Genesis consent/signature | The completed binding must be confirmed under the network-specific rule and checked against the intended arena deployment using an independent chain view. | Do not sign. A signature over a displaced binding remains historical data and must not be retargeted. |
| Activation and escrow admission | Registration, binding, both signatures, and the authorized flag must be read from one pinned block that has passed the network-specific rule. At least one independently operated chain view must corroborate the application RPC. | Do not enter escrow mode or sign READY/inputs. Current browser behavior is intentionally local-only because it lacks this production check. |
| Archive publication and trace claim/challenge | All prerequisite arena state must already be confirmed under the network-specific rule. A newly submitted transaction remains pending until it also passes that rule. | Do not calculate obligations from a pending receipt. Re-read state after confirmation. |
| Midpoint/adjudication turn | Read canonical `TraceGame` state, round, responder bits, and deadline at a pinned head; monitor inclusion until finality. Contract time is authoritative only on the canonical chain. | Resubmit only if still admissible on the new canonical state. Never reuse an orphaned round/deadline assumption. |
| Verdict | Treat `TraceAdjudicated` and `getTraceGame` as tentative until the adjudication transaction passes the network-specific rule and both views agree. | Recompute from the last confirmed dispute state. No economic reliance. |
| Future settlement | Require finalized dispute inputs and define when the settlement transaction itself is final. External services must wait before taking irreversible off-chain action. | Fail closed and continue monitoring; no provisional payout assumption. |

“Independent” means the application RPC cannot confirm its own answer. The
second view must fail differently—for example, a provider operated by a different
organization, a verified light client, or another reviewed chain-verification
method. Two URLs run by the same company on the same infrastructure may share the
same failure and therefore may not be meaningful corroboration. The network's
rulebook must state what qualifies.

## Reorganization handling

1. Persist the locator, block number/hash, transaction hash, and derived context
   for every chain-dependent admission or dispute action. Block number alone is
   insufficient.
2. Detect ancestry changes against the last checkpoint confirmed under the
   network-specific rule. Stop signing new match inputs and stop economic
   automation while the canonical state is uncertain.
3. Roll back all derived local protocol state whose source block was displaced.
   Preserve the old signed/journal data as explicitly orphaned historical
   evidence; never rewrite or silently rebind it.
4. Re-read deployment identity, registration, binding, authorization, challenge
   status, trace phase, roots, round, responses, and deadline from the new
   canonical history.
5. Rebuild any authority-qualified bundle from the unchanged public journal and
   the new authoritative record. If the binding/context changed or disappeared,
   the old root has no current authority.
6. Resubmit an action only when it remains valid in the new state. A transaction
   confirmed on the abandoned fork does not satisfy a response obligation.
7. Wait for the deployment's finality rule again before dependent action. If a
   reorg crosses the assumed finality boundary, activate the deployment's
   emergency policy; that policy is unresolved and must exist before real funds.

The current application does not implement this rollback state machine. That is
why its saved chain record is inspection evidence and why public deployment
remains prohibited.

## Current enforcement versus required production behavior

| Area | Current prototype | Required before economic use |
| --- | --- | --- |
| Local durability | Strict IndexedDB transaction before send/use; export after reload. | At least one defined external replication/delivery path with measurable obligations. |
| Archive commitment | Participant may bind root to `journalHash`. | Retrieval locator/protocol, authenticated delivery receipt or objective deadline evidence, and retention policy. |
| Evidence completeness | Whole supplied journal is rebuilt; conflicts and missing dependencies fail closed. | A way to obtain all obligated bytes and distinguish withheld from not-yet-delivered data. |
| RPC trust | One injected provider, one pinned block number. | Deployment identity check, independent corroboration, block hash/ancestry retention, and reads confirmed under the network-specific rule. |
| Reorg response | None beyond repeatable historical reads. | Pause, rollback, rebuild, resubmit, and emergency behavior as specified above. |
| Non-response | Contract has deadlines but no complete consequence/escape. | Issue #4 state matrix covering each actor and turn after delivery preconditions. |
| Economic result | Neutral isolated-step verdict only. | Reviewed settlement mapping with a terminating exit from every funded state. |

## Open decisions

These use the decision-log structure but remain **Open**, not accepted defaults:

### EA-001 — Archive delivery and replication

- **Date:** 2026-10-29
- **Status:** Open
- **Decision needed:** Choose the retrieval locator, minimum independent copies,
  authenticated delivery evidence, availability deadline, and publisher service
  obligation for each fixed root.
- **Constraint:** A hash or transaction alone cannot count as delivery. No storage
  vendor is selected by this specification.

### EA-002 — Production chain finality profile

- **Date:** 2026-10-29
- **Status:** Open
- **Decision needed:** For each supported chain, choose deployment code identity,
  finalized-tag or confirmation-depth rules, independent corroboration, maximum
  tolerated reorg, and emergency response beyond that bound.
- **Constraint:** Local Hardhat behavior and chain ID 31337 are containment, not
  a production finality policy.

### EA-003 — Availability and response clocks

- **Date:** 2026-10-29
- **Status:** Open; coordinated with Issue #4
- **Decision needed:** Define when evidence delivery is sufficient to start each
  response clock, how failed delivery is proven, and whether retryable chain
  uncertainty pauses, restarts, or invalidates a clock.
- **Constraint:** A party cannot be penalized for failing to answer data it was
  never objectively able to retrieve.

### EA-004 — Retention and deletion

- **Date:** 2026-10-29
- **Status:** Open
- **Decision needed:** Set the archive retention duration, replication repair,
  resource bounds, and safe deletion point after final settlement/reorg windows.
- **Constraint:** Derived roots, transcripts, and openings cannot replace the
  complete source journal.

### EA-005 — Economic mapping of evidence failures

- **Date:** 2026-10-29
- **Status:** Open; owned by Issue #4
- **Decision needed:** Map objective fault, unavailable evidence, non-response,
  incomplete/conflicting traces, retryable uncertainty, and each step verdict to
  terminating funded-state outcomes.
- **Constraint:** The categories above remain distinct unless Issue #4 explicitly
  justifies an equivalence and preserves an exit from every funded state.

## Out of scope

- Implementing storage, replication, pinning, indexing, or retrieval services.
- Adding providers, light clients, confirmation polling, reorg recovery, UI,
  contracts, or tests.
- Choosing a storage vendor, decentralized storage network, production chain, or
  universal confirmation count.
- Redesigning trace execution or selecting payout, bond, fee, and forfeiture
  economics. Issue #4 owns those consequences.
