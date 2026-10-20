# Phase C: canonical durable evidence to dispute artifacts

Phase C integrates the existing evidence and trace components. It introduces no
execution adjudicator, reputation, forfeiture, payout, or timeout economics.
Settlement remains disabled.

## Read-only integration audit

The audit preceded implementation and found these gaps:

| Question | Finding and resolution |
| --- | --- |
| Trace source | Trace builders and CLI accepted a selected transcript. Live exports now read the entire durable journal through a serialized snapshot. The new evidence CLI uses the same pipeline. |
| Lifecycle and acknowledgements | READY statements, chained input acknowledgements, transport observations, duplicates, and buffered inputs existed but had no canonical extraction contract. Reconstruction authenticates readiness and every supplied signed variant; transport observations never order gameplay. |
| Unique derivation | Browser exports depended on UI state and a map selecting one packet per slot/frame. A pure reconstruction function now defines ordering, completeness, frames, state sequence, and final metadata. |
| Conflicts | A late conflict could remain in evidence while disappearing from a terminal UI transcript. The entire supplied signed set is scanned before replay; any conflicting payload prevents a canonical transcript/trace. |
| Incomplete histories | Transcript verification detected missing execution inputs but knew nothing about missing lifecycle or buffered orphan evidence. Reconstruction returns explicit status and dependency diagnostics. |
| Reload equivalence | Recovery and uninterrupted UI snapshots could differ, especially after a conflict or a commit interrupted by disconnect. Export ignores both snapshots and reconstructs from committed journal rows. |
| Practice versus escrow | Input signatures alone bind genesis, not live mode. Mode-bound readiness must be verified, and practice cannot be promoted by supplying an escrow record. |
| Availability | A root and one opening were insufficient. A versioned bundle now retains all source evidence, states, checkpoints, and tree levels needed to regenerate every opening and step witness. |
| Merkle/bisection assumptions | The codec, domains, fixed horizon, and tree depth remain valid. Membership still does not prove lifecycle admission, execution, completeness of externally withheld evidence, or availability. |
| Retention/export | The raw journal and all reconstruction inputs must remain available. Bare transcripts and compact claims are insufficient replacements. |

No material policy decision was needed. A non-complete artifact status refuses
certification of supplied evidence; it does not assign blame, a winner, or a
financial consequence. The Phase B separation of protocol faults, liveness,
and behavioral policy remains intact.

## Single evidence-first pipeline

1. `LiveMatch.exportEvidence()` waits behind queued controller operations and
   reads IndexedDB in a transaction. Its `phase-b-journal-v1` archive includes
   committed rows even if a transport replacement interrupted in-memory admission.
   Saved-match export reads the same durable source after reload.
2. `reconstructEvidence()` snapshots the archive, checks strict schemas and bounds,
   validates descriptor/rules/identities and historical genesis consistency, then
   verifies every READY signature and input signature in its proper domain.
3. Byte strings have one lowercase representation. Exact payload duplicates are
   suppressed by player/frame/payload hash. If equivalent payloads carry multiple
   valid signature representations, the lexically smallest verified representation
   is selected. Packets sort by frame, player, then payload hash; readiness sorts
   by slot. JSON object keys sort lexically using `canonicalJson()`.
4. Different signed payload hashes at the same player/frame are conflicts.
   **Any supplied conflict, including an unused tail conflict, prevents canonical
   gameplay/trace output.** No branch-selection parameter exists. Invalid chain
   links also prevent that output; missing dependencies remain incomplete.
5. Once both readiness statements exist, recursively valid pairs execute in
   contiguous frame order from canonical genesis until the first terminal state.
   The canonical transcript contains **executed packets only**. All delayed tails,
   orphans, conflicts, duplicates, and observations remain in the source archive;
   normalized signed evidence retains every distinct payload supplied.
6. The existing verifier checks the derived transcript. Complete uncontested
   reconstruction passes to the unchanged v2 checkpoint/Merkle implementation.
   Transcript final fields, states, checkpoint heads, leaves, and root are all
   recomputed; no caller-supplied UI state or cached derived claim is trusted.

The journal array is a retention record, not a trusted global clock. Reordering
its signed messages does not change canonical gameplay. Both signed readiness
statements must be present; local row order is not proof of when a peer signed.
Disconnect timestamps and retransmission timing never become gameplay inputs.

## Reconstruction outcomes

| Status | Meaning | Canonical trace |
| --- | --- | --- |
| `complete` | Both readiness statements, terminal execution, all supplied dependency links valid, no supplied conflict, and tail within the canonical delay horizon | Yes |
| `incomplete` | Missing readiness, execution input, or dependency for supplied buffered/tail evidence | No |
| `conflict` | Multiple authenticated payloads at a player/frame, even after termination | No; no selected transcript |
| `invalid-chain` | A supplied authenticated packet contradicts available dependency links or genesis sentinels | No; no selected transcript |
| `outside-horizon` | Authenticated data extends beyond terminal frame plus INPUT_DELAY | No; preserve inspection evidence |

A complete game with an orphaned supplied tail has `gameplayComplete: true` but
`status: incomplete`; nothing is silently discarded to make it certifiable.
Conversely, absent optional tail packets do not invalidate complete execution.
Over-horizon records remain exportable because Phase B's receive window can
retain them. None of these statuses determines a financial outcome. Malformed
or unauthenticated archives are rejected rather than attributed to a player.

The archive is bounded to 10,000 rows and a 16 MiB canonical-JSON size guard;
local observation count remains bounded to 1024. These are import/resource
bounds, not economic deadlines.

## Commitments and recovery equivalence

There are separate digest scopes:

- `journalHash` identifies the exact retained archive, including duplicates,
  local observations, local slot, and chain lookup provenance.
- `evidenceHash` identifies the canonical descriptor, readiness statements, and
  normalized distinct signed packet set. Local transport metadata is excluded.
- `transcriptHash` and `statesHash` identify canonical JSON for executed gameplay.
- The trace root continues to commit canonical ABI checkpoint bytes in the
  existing v2 Merkle context. It does not commit unused tails or transport events.

For identical committed evidence, uninterrupted export, reload recovery, browser,
and Node CLI produce byte-identical canonical transcript, state sequence, leaves,
root, and openings. Different journal order, duplicate rows, local observations,
or local slot do not change gameplay outputs. Additional valid unused tail
packets change evidence retention/digests but not executed transcript or root.
The raw journal and therefore the complete bundle need not be byte-identical
between peers with different local observations or arrival histories.

Exports are snapshots. Evidence arriving after capture may invalidate a previous
complete assessment; keep the newer evidence and regenerate. Neither a local
snapshot nor its digest proves that another participant has not withheld a
conflict or dependency. This limitation cannot be solved by selecting a transcript.

## Authority and mode separation

Practice descriptor/READY domains remain distinct from escrow domains. Practice
artifacts use the existing diagnostic trace context and cannot be upgraded by
passing an authorization record.

Escrow evidence can be reconstructed offline from its public signed binding and
historical record. Such a bundle says `authority: historical-inspection`, uses
`genesis-historical-trace-v2`, and does **not** assert `genesisAuthorized: true`.
Its context/root bytes are the same bytes obtained for that binding when an
independent authoritative record is later verified.

A caller supplying a record from an independently pinned trusted lookup may
explicitly rebuild with `buildEvidenceBundle(archive, record)`. That produces
`authority: independent-record` and the existing authorized trace metadata.
The API cannot establish the provenance of an arbitrary caller's record object;
callers must use the trusted lookup contract. An embedded record, JSON flag,
or lookup block number is not proof of canonical-chain activation/finality.

Import verification rebuilds and compares every field. A historical bundle does
not silently become an independently authorized bundle when passed a fresh
record: explicitly rebuild from its archive in that authority mode. Browser
exports and the offline CLI deliberately use historical inspection for escrow.
Every mode remains `settlementEligible: false`.

The old `buildExecutionTrace`, `buildAuthorizedExecutionTrace`, `commit-trace`,
and `verify-trace` interfaces remain low-level transcript diagnostics and codec
compatibility tools. They authenticate what they are given, but cannot establish
that a selected transcript includes all retained lifecycle/conflict evidence.
They are not the Phase C evidence admission API. Dispute integrations must use
and validate the evidence bundle instead.

## Required retained/exportable artifacts

A `phase-c-dispute-bundle-v1` contains:

- the full versioned public journal, immutable descriptor/rules fingerprint,
  participant keys and slots, both signed READY statements;
- escrow binding and authorization signatures plus historical registration,
  activation record, and chain/arena/challenge/block lookup provenance;
- every retained signed input and chained acknowledgement, including buffered
  inputs, delayed tails, conflict witnesses, and duplicate rows;
- local observations explicitly separated from signed protocol facts;
- reconstruction status, canonical distinct signed set, missing-dependency and
  conflict diagnostics, and the journal/evidence digests;
- the canonical executed transcript, complete state sequence and their digests
  when an unambiguous prefix can be derived;
- for complete evidence: terminal commitment, all 301 checkpoints, all Merkle
  levels, and genesis/actual-terminal/fixed-horizon endpoint openings.

Retain the matching v2 rules/codec implementation or specification as well.
No private signing key or resumable session authority belongs in this package.
Do not discard the archive after exporting only a transcript or root.

`loadEvidenceDefense()` rebuilds and verifies an imported complete bundle once,
then exposes immutable-derived `opening(index)` and `step(frame)` artifacts.
An executed-step witness includes both signed inputs, pre/post states, and
adjacent checkpoint openings. Those checkpoints include previous packet heads
needed for the fixed F-2 acknowledgement rule. After the actual terminal frame,
`terminal-absorption` witnesses contain the terminal state and adjacent absorbing
openings; they do not fabricate extra signed/executed frames. Every index 0..300
can be opened without the peer or UI state. Padding leaves 301..511 are only tree
padding, not gameplay states or bisection indices.

## Browser and CLI

`Download JSON` / `Copy Transcript` now reconstruct complete live evidence and
refuse to hide incomplete or conflicting records behind a terminal transcript.
`Export dispute evidence` exports the full live bundle, including non-complete
inspection bundles. Saved evidence inspection exports the same bundle after
reload, without recovering signing authority. Pre-live genesis consent journals
remain separately inspectable public preparation evidence.

```
npm run --silent evidence-trace -- build archive.json > bundle.json
npm run --silent evidence-trace -- verify bundle.json
npm run --silent evidence-trace -- step bundle.json 91 > step-91.json
```

`build` also accepts a bundle and rebuilds from its archive. `verify` distinguishes
valid serialization/reconstruction (`ok`) from complete dispute evidence
(`complete`). `step` refuses incomplete/conflicted bundles. No command sends a
transaction or obtains chain authority from a file.

## Bisection / one-step assumptions consumed by Phase D

The 301-checkpoint horizon, depth nine, ordered hashes, context domains, absorbing
terminal checkpoint, and Solidity membership codec are unchanged. Integration
checks compare evidence-derived roots to the old codec and Solidity openings
against an actually activated local EVM record.

Bisection still proves membership and locates a disagreement; it does not prove
execution or certify the rest of either root. Its on-chain admission does not
verify a Phase C bundle or READY statements. [Phase D](PHASE_D.md) now consumes
the authenticated pre-state, inputs, checkpoint heads, fixed-point rules, and
terminal-absorption distinction for one independently executed step. The F-2
witness structure assumes the current fixed INPUT_DELAY=2 rules fingerprint.

Local export is not an external availability service. Later phases must define
availability commitments/delivery, withheld or lost evidence, canonical-chain
activation/finality and reorg handling, claim replacement, and objective eventual
escrow escape paths. A retained bundle protects against dependence on the other
peer/UI, but not deletion, browser eviction, disk loss, or a compromised origin.
No root or endpoint opening alone establishes those guarantees.

## Completion validation

Phase C passed 105 Node tests, 43 contract tests, and 5 Chromium browser tests.
Coverage includes journal ordering/duplicates, missing readiness/dependencies,
late and unused-tail conflicts, invalid chains, over-horizon inspection, every
opening and step witness, authority separation, tampered artifacts, browser/CLI
byte equivalence, and disconnect/reload recovery without signing authority.
The contract integration uses an actually activated genesis record and checks
the evidence-derived root, terminal state hash, and Solidity membership openings.
Lint, production build, and diff whitespace checks passed. The existing build
bundle-size warning remains. Independent read-only review found no remaining
blockers after the over-horizon export fix. Phase C is complete; no later-phase
adjudication or economics have been enabled.
