# Implementation takeover — 2026-09-16

Baseline: clean `codex/crypto-fighter-finish` at `672d090`. Findings below were
checked against source and executed commands, not prior agent summaries.

## Architecture and actual flow

- `src/App.tsx`: React DOM game, PeerJS host/join handshake, two-frame delayed
  signed inputs, retained packet/canonical histories, replay and wallet panel.
- `src/game.ts`: cumulative pure transition, 30 FPS, 300 frames, 7 HP, movement,
  jumping and attacks. Each overlapping active attack frame deals damage. KO
  precedes timer resolution; equal HP at expiry or double KO is `TIE_BOTH_LOSE`.
- `src/crypto.ts`: raw recoverable secp256k1 signatures over ABI-encoded match,
  frame, slot, mask and self/opponent hashes. Canonical frame hashes bind paired
  inputs. Final state hashing uses JSON serialization.
- `src/verifier.ts` and `tools/verify-match.mjs`: separate browser/CLI replay
  implementations. Signatures, self chains, delayed acknowledgements and
  canonical frame hashes are checked for traversed frames.
- `contracts/CryptoFighterArena.sol`: equal-stake escrow and delegated session
  keys. Arbitrary optimistic result claims finalize after a deadline. A signed
  next-frame pair pays the disputer; no execution proof is checked. Timeout
  claims/responses require only nonzero hashes. Ties refund both stakes.
- `hh/`: Hardhat local EVM tests. `tools/simulate-arena.mjs` models a different,
  co-signed result API and is not evidence for the deployed Solidity behavior.

## Existing protections and gaps

Present: known input bits 0..15, packet signatures, self/ack chains, slot/key
checks, participant checks, equal stakes, optional restricted opponent,
wallet-authorized session delegation, minimum 24-hour response window, inclusive
dispute versus strictly-later finalization boundary, payout reentrancy guards,
and effects before transfers.

Absent or unsafe: terminal execution proof; sound outcome disputes; authenticated
timeout history; signature binding to chain, arena, challenge, both participants,
rules and escrow context. Stored context hashes are not signed by input packets.
Rules metadata is not pinned by the verifier. Missing final records and partial
histories can verify; extra records and post-terminal canonical history are not
fully rejected. Handshake keys/context can be replaced and start/reset messages
lack a strict authenticated lifecycle. There is no implemented leaderboard/wallet
lookup flow. The baseline had no enforced deployment/funding restriction.

## Baseline checks

| Check | Observed result |
| --- | --- |
| `npm run lint` | Pass; config targets TypeScript/TSX, not all JS scripts |
| `npm run build` | Pass; bundle-size warning |
| `npm run test:input-mask` | Cannot start on installed Node 20: unsupported strip-types flag |
| `npm run test:contract` | 25 pass after approved access to Hardhat configuration/cache and compiler download |
| Transcript generation + CLI verification | Pass, P1 wins at frame 91, HP 7–0 |
| `npm run simulate-arena` | Fails without expected transcript input; stale model API |
| Browser automation | Not run: scripts reference missing absolute Playwright installation paths |

The contract suite's passing optimistic-settlement tests establish the current
behavior, including unsafe behavior, rather than payout security.

## Dependency order

1. Enforce development-only containment before exposing escrow activity.
2. Restore reproducible Node/contract/browser checks and remove stale harness assumptions.
3. Strict bounded transcript validation from genesis through the first terminal
   state; distinguish partial replay from payout evidence; pin rules/version.
4. Bind all signed facts to a frozen match/escrow context, with browser/CLI/
   Solidity digest parity and an authenticated connection lifecycle.
5. Implement terminal execution proofs and disputes that determine the actual
   supported outcome, including delayed pre-signed inputs and equivocation.
6. Define and authenticate timeout checkpoints/responses and recovery without
   enabling unsupported payouts or conflicting claims.
7. Integrate matchmaking/gameplay/settlement state and leaderboard/wallet lookup.
8. Complete adversarial and browser end-to-end checks, documentation and review;
   real-money deployment remains disabled throughout.

## First increment

Browser settlement client construction now throws before touching a signer; all
four transaction buttons are disabled with an explanation. The supplied deploy
script rejects every network except in-process Hardhat chain 31337. The contract
constructor independently rejects other chain IDs. There is no enable flag.
These restrictions cannot establish safety for arbitrary networks using 31337
or modified copies of the source, and do not repair existing deployments.

Validation: lint/build pass, 9 Node tests pass (approved outside-sandbox run;
sandbox child-process output caused failures), and 27 contract tests pass,
including direct construction rejection on a simulated foreign chain. Node tests
now use a TypeScript loader compatible with Node 20. CLI verification uses
`process.exitCode` so normal output can drain before process termination.

## Reproducible harness increment

`npm run check` now composes JS/TS lint, Node tests, production build, actual
contract tests, and a repository-local Playwright suite. Playwright and PeerJS
server are pinned development dependencies. Browser servers use loopback, no
external signaling/STUN, and real WebRTC channels. System Chromium can be selected
with `CHROMIUM_PATH`; otherwise install Playwright Chromium once. Old smoke
entry points forward to the suite; stale arena simulation and browser escrow
scripts now fail explicitly rather than exercise a different protocol.

Hardhat uses pinned npm `solc` 0.8.26 and repository-owned XDG directories.
A forced compile passed without the compiler downloader. Sandbox child-process
output truncation still requires approved outside-sandbox execution in this
workspace; browser tests also need permission to bind loopback sockets.

Validation: combined check passed (9 Node tests, 27 contract tests, 2 browser
tests), followed by a tenth Node regression for byte-for-byte fixture generation.
Browser tests verified a terminal P1 replay against the CLI and an entire live
300-frame idle match, matching both peers' canonical histories and final state.
Lint now includes JS harnesses; production build retains its bundle-size warning.
These checks do not cover disconnect/reconnect, malicious handshakes, or prove
settlement security. Strict transcript completeness/context remains next.

## Strict transcript increment

Browser and CLI now execute one verifier/transition implementation. Strict mode
requires bounded, contiguous canonical history from genesis through the first
terminal state, exact declared v1 rules, distinct valid curve-point identities,
and every final field. All supplied packets, including delayed unused inputs,
are authenticated. Missing/genesis/interior packets, duplicate/gapped canonical
frames, malformed fields, changed rules and canonical continuation after a
terminal state fail. The browser computes the exported state hash on demand,
so a partially exported replay cannot depend on a pending React hash effect.

Partial replay requires `--allow-partial` or the explicit browser checkbox and
returns `complete: false`. Every v1 result returns `settlementEligible: false`,
including a complete terminal result: v1 signatures still omit escrow context.
Valid future packets do not change terminal frame or terminal packet heads.

The remaining protocol blockers are frozen match/escrow context, signatures
bound to that context and the complete rules specification, authenticated
connection lifecycle, execution proofs/disputes, and timeout/recovery. Nothing
in this increment enables settlement or changes combat/escrow rules.

Validation: full `CHROMIUM_PATH=/usr/bin/chromium npm run check` passed: JS/TS
lint, 42 Node tests, production build, 27 contract tests, and both real-browser
tests. The live 300-frame exports pass strict verification in browser and CLI.

## Merkle/bisection architectural constraint and trace primitives

The user pinned the intended design to optimistic Merkle trace claims,
interactive bisection, and minimal one-step adjudication. Complete transcripts
stay off-chain; Solidity must never receive/replay the full match. Inspection of
tracked source and available history found the README's existing proposal but
no implementation. The current continuation-packet dispute materially conflicts
and will require replacement; the off-chain transition and strict verifier fit.

`docs/EXECUTION_TRACE.md` preserves the proposal and records the encoding,
checkpoint/adjacent-transition relationship, bisection invariants, availability
and non-response requirements, optimistic-security assumptions and unresolved
protocol boundaries. It explicitly distinguishes isolating an inconsistent
transition from proving a globally earliest mismatch in arbitrary reconverging
fraudulent traces. The settlement contract is unchanged in this increment.

Implemented: experimental off-chain canonical ABI state encoding (exact half-unit
geometry), rules/genesis commitment, ordered domain-separated Merkle tree,
checkpoint openings, and independently rebuilt commitment verification. CLI
generation/verification and browser parity are covered. Terminal checkpoints
normalize to a fixed comparison horizon; unused delayed inputs cannot change
the root. These commitments are expressly not escrow-authorized: v1 signatures
still lack chain/contract/challenge/participant/rules/escrow domain binding.

Validation: combined check passed with 48 Node tests, 27 contract tests, both
browser tests, lint and build. An additional received-commitment regression and
CLI check brings the Node suite to 49 tests. Bisection transactions, minimal
Solidity transition adjudication and authenticated dispute timeouts remain
unimplemented. Real-money activity remains disabled.

## Canonical rules and unique genesis clarification

The user clarified that there is one canonical gameplay/protocol version at a
time, never per-match damage, timer or physics settings. Inspection confirmed
the game used compiled constants, strict replay rejected altered rules metadata,
and the trace fingerprint was already fixed globally. The misleading surfaces
were a generic `rulesHash(rules)` helper and escrow acceptance of any nonzero
rules hash.

Centralized fixed metadata, state encoding and the existing byte-identical
fingerprint in `src/protocol.ts`; removed the arbitrary-rules helper. Browser
export and verifier now share canonical metadata. The contract accepts only the
canonical fingerprint, with matching off-chain/on-chain regression coverage.
Legacy v1 metadata and trace roots are preserved; no combat rule changed.

Live IDs already use fresh random 256-bit genesis nonces. Each move digest
includes that ID, making its first move and subsequent chains match-specific;
zero previous hashes are only sentinels. Fixture IDs remain intentionally fixed.
The intended binding is an authenticated unique genesis-to-escrow record before
play; moves may reference that genesis without repeating the record's fields.
Docs now explicitly preserve that design. Secure unique registration and
cross-domain genesis/session adoption remain unfinished; randomness is not
authorization and these changes do not enable settlement.

Validation: lint/build passed, all 51 Node tests passed, all 28 contract tests
passed, and both browser tests passed. The canonical-rules rejection test checks
decoded revert data because viaIR source mapping omitted Hardhat's reason text.

## Authoritative genesis and authorized trace increment — 2026-09-17

The arena now permanently reserves each genesis, snapshots the completed binding
at join, and verifies one-time authorizations from both distinct delegated session
keys. The binding includes chain, arena, challenge, canonical version, wallets,
session keys and original escrow terms. Move digests remain byte-identical and
carry only genesis plus move-chain fields. Authorization is required before the
legacy result/timeout entry points. Unactivated joined matches refund each deposit
once after a contract-recorded deadline; activation includes the deadline, refunds
require strictly later time. Binding/registration survive cancellation and payout.

`src/genesis.ts` reads a pinned chain/arena/challenge record at one block, checks
registration and both session signatures, and provides a session signer locked
to one binding/expected main wallet. It blocks pre-activation and conflicting
move signatures. Browser and contract signature recovery now agree on low-S and
v=27/28. A supplied authorization cannot be its own authoritative chain record.

Authorized trace APIs rebuild the terminal history under the registered binding
hash, check genesis/session identity, and use a separate authorized format.
Diagnostic roots cannot be relabeled as authorized. Every output remains
`settlementEligible: false`. The browser's funded lifecycle is not yet wired to
these APIs; existing live-browser games remain practice games.

`src/bisection.ts` authenticates fixed-root endpoint/midpoint openings and isolates
adjacent checkpoint indices in at most nine rounds. It is an off-chain coordinator,
not a live transaction/deadline/payout state machine. Solidity's new pure
`TraceCommitmentVerifier` verifies exactly the same compact checkpoint branches;
no full transcript is received/replayed on-chain. An integration test builds from
an actual activated Hardhat record and verifies those openings in Solidity.

Validated: full lint/build, 57 Node tests, 35 contract tests and two browser tests
passed. Tests cover duplicate genesis, cross-contract replay, altered bindings,
signature malleability, exact activation/refund deadlines, repeat refunds, registry
immutability, unauthorized roots and malformed/replayed bisection openings.
See `docs/GENESIS_AUTHORIZATION.md` for encoding, trust roots and current limits.
Nonce reservation preemption can require retry; push-refund recipients can refuse
transfers. Neither problem is claimed solved. On-chain claims/bisection turns,
minimal transition adjudication, dispute deadlines and complete recovery remain
next. The legacy optimistic/continuation payout code remains an unsafe local-only
sketch; real-money/browser settlement stays disabled.

## On-chain trace turns — 2026-09-17

Verified the clean checkpoint at `58474a4`. Added arena-bound trace claims,
canonical genesis and terminal endpoint openings, opponent counter-commitments,
and authenticated midpoint rounds. Roots/context remain fixed. Both openings
are required before changing equal(low)/unequal(high); nine rounds suffice.
Round IDs prevent replay, and a first response cannot extend the shared clock.
Legacy result/gameplay-timeout entry points cannot bypass a trace claim.
No new payout or recovery authority is introduced; local test stakes remain
locked once a trace claim is created while the remaining machinery is developed.

Validation of the turn increment: lint and 41 contract tests passed. Commit
`0df363f` records this increment.

## Blocking correction to state-encoding assumption — 2026-09-17

During one-step implementation, independent review disproved the half-unit
geometry invariant recorded above. Reachable sequence: 85 frames (2,0), 110
frames (1,0), 55 frames (2,1) produces quarter-unit x positions at frame 250.
Independent wall clamping is the missing case. The new regression continues
to a terminal tie with valid signatures/self/ack/frame chains, verifies it
strictly, and demonstrates rejection by both trace builders. This is a known
limitation test, not an assertion that rejecting honest traces is acceptable.

The unfinished transition verifier and dependent expiry/classification work
were removed before commit. No gameplay, state encoding, domain or canonical
fingerprint was changed. Approval is required for a new exact state encoding/
version before resuming adjudication. Increasing the scale without establishing
a sufficient bound is not a repair. Full on-chain replay is still prohibited.
Browser settlement and real-money deployment remain disabled.

Final validation after removing the unfinished verifier: full
`CHROMIUM_PATH=/usr/bin/chromium npm run check` passed: lint, build, 58 Node
checks, 41 contract tests and 2 browser tests. The existing bundle-size warning
remains. The new geometry regression passes by documenting the codec failure;
it is not evidence that the failure has been repaired.

## Exact horizontal numeric-domain analysis — 2026-09-17

Analyzed the unchanged native transition before any trace-format decision.
Repeated independent clamp/recollision cycles reach eighths, sixteenths, and
every precision through 47 fractional bits. An adjusted final recollision reaches
48 bits by frame 203. The two scale 2^48 numerators are odd, proving tightness.
An inductive binary64 spacing proof bounds every stored x coordinate to the
2^-48 lattice in [0,692]; see docs/HORIZONTAL_NUMERIC_DOMAIN.md.

The actual simulator does not refine indefinitely. An ideal unrounded rational
version would do so if its timer were removed; native rounding and terminal
absorption prevent that. Exact integer state words fit in 58 unsigned bits, but
integer transition arithmetic must reproduce binary64 rounding after each
operation. The analysis includes a concrete case where unrounded averaging
diverges from the existing game.

Added test-only BigInt rounding-oracle checks, a complete 300-frame tight witness,
all 256 mask pairs at ten reachable states, bounded exhaustive motion exploration
and 64 seeded complete matches. Neither these tests nor the analysis alter
gameplay, the codec, canonical fingerprint, genesis authority or settlement.

Validation: lint and all 63 Node tests pass. New bounded searches checked 154,836
reachable motion transitions; seeded properties checked 18,790 transitions across
64 full matches, in addition to 2,560 mask-pair cases and the exact witness.
Independent read-only review confirmed the proof and rounding oracle.

## Phase A — canonical fixed-point v2, 2026-09-17

Approved migration replaces development binary64 physics with SCALE=256 integer
geometry. Compared floor, nearest/ties-up and nearest/ties-even midpoint rules;
selected ties-even for exact stage-reflection symmetry without rounding residue
state or a directional tie preference. The existing equal-x P1-left body ordering
is explicitly retained. See docs/FIXED_POINT_PROTOCOL.md for the numeric contract,
proof of midpoint symmetry, bounds, ABI layout and behavior characterization.

All positions/vertical velocity and geometry constants use simulation units.
Fighter dimensions are rules constants, no longer mutable state. Rendering converts
at the DOM boundary. Transcript v2 requires the new rules fingerprint and uses the
same canonical ABI state hash as traces. The generator now imports the production
simulation. Old replay versions/fingerprints are rejected; the old simulator lives
only in a test fixture for historical analysis and behavior comparison.

Existing contract state tuples/genesis constants, trace domain tags, and canonical
fingerprint were migrated for format consistency. No transition adjudication,
resolution, recovery, or payout entry point was added. Browser/deployment
containment is unchanged. Test-only Solidity rounding code is compiled in memory
and is not part of the escrow or any one-step verifier.

Validation: full `CHROMIUM_PATH=/usr/bin/chromium npm run check` passed: lint,
73 Node tests, production build, 43 local contract tests, and two real-browser
tests. The existing bundle-size warning remains. New coverage includes all 368641
midpoint numerators, mirrored mask-pair scenarios, independent BigInt simulation
and manual ABI encoding, 13 golden transition vectors, Solidity codec/rounding
parity, strict v1 rejection, the formerly unencodable authenticated transcript,
and actual DOM geometry conversion. No production gas saving was measured.

Old/new characterization over 128 seeded/random-plus-wall-stress matches compared
31907 transitions while both pre-states were active, with a sampled maximum x
error of 1/512 game unit. Three wall-stress cases changed terminal frame or winner
(two timing changes, one winner change) because strict hit-boundary results changed.
Ordinary movement/jump/approach-attack scenarios matched after unit conversion.
These are sample results, not a universal outcome/error guarantee or a human
playtest claim. Phase A is complete; Phase B and later remain pending.


### Phase A exit revalidation — 2026-09-18

Reviewed all 33 changed/new files against the fixed-point/protocol-v2 scope.
Contract edits migrate only the fingerprint, state tuple, genesis constants and
hash domains; no Phase B lifecycle/input implementation or later adjudication,
recovery or payout authority is introduced. Corrected the next-step wording in
the trace/genesis documentation: Phase B authenticated match/input work precedes
single-transition adjudication, regardless of existing bisection infrastructure.

Full `CHROMIUM_PATH=/usr/bin/chromium npm run check` passed again: lint, 73 Node
tests, build, 43 contract tests and both browser tests. The initial sandbox run
failed on Node subprocess EPERM; the outside-sandbox rerun passed in full. The
existing bundle-size warning remains. Settlement/deployment containment is
unchanged. Phase A is ready for its local checkpoint; Phase B remains pending.

### Phase B evidence foundation — 2026-09-18

Added an authorized-genesis evidence collector with session-bound signature
checks, immutable snapshots, duplicate handling, retained signed equivocations,
and separate missing-dependency / observed-chain-mismatch diagnostics. Local
liveness observations have no winner or financial authority. Tests exercise
forgery, late conflicts, caller mutation, retransmission, and delayed dependencies.

`docs/PHASE_B.md` records the durable architectural separation of protocol
faults, liveness recovery, and higher-layer behavior policy. It requires an
objective eventual escape from every funded state without equating ordinary
disconnects with cheating. No reputation system or settlement changes were made.
This is a foundation, not Phase B completion: browser lifecycle integration and
crash-durable evidence persistence remain outstanding.

Validation: `npm test` passed all 78 tests (rerun outside the sandbox after
subprocess EPERM restrictions); `npm run lint`, `npm run build`, and
`git diff --check` passed. Build retains the existing bundle-size warning.

### Phase B — authenticated live lifecycle and durable evidence, 2026-09-18

Replaced the browser's ad hoc packet admission and unsigned start/reset handling
with a serialized live controller. Fresh signed discovery challenges pin the
connection identity; immutable practice/escrow descriptors and two signed READY
statements gate inputs. Exact schemas, participant/domain/signature checks,
recursive dependency validation, bounded reordering, and connection/controller
generations gate authoritative mutation. Local preparation actions are serialized
so delayed chain lookups cannot race match creation.

IndexedDB transaction completion precedes outgoing sends, incoming use, and
chained acknowledgement signing. Public genesis consent is committed before
export. The journal retains authorization/provenance, readiness, signed input
chains and conflicts, plus bounded local connection observations. Successful
commits interrupted by a transport-generation change are reconciled before
reconnect can resume; a conflict committed during that interval still halts play.
Private keys remain ephemeral. Recovery is inspection-only, and local reset
preserves prior journals while creating new keys/genesis.

The collector owns duplicate/conflict handling and recursive chain admission;
retransmission replies reuse committed signatures. Disconnects, gaps, and storage
failures do not award a winner. Settlement transaction gates remain unchanged;
no reputation, forfeiture, payout, or timeout economics were added. Phase C/D/E
still need execution adjudication, availability/replacement policy, and objective
escrow escape paths before funding or settlement can be enabled. See PHASE_B.md.

Final Phase B validation: 92 Node tests, 43 contract tests, and 5 browser tests
passed. Browser coverage includes complete two-peer histories, real disconnect/
reconnect, reload inspection, atomic journal initialization, and the escrow UI
against a fixture RPC, including an RPC-delayed consent/start race. Existing
Hardhat coverage separately verifies actual genesis activation. Build, lint, and
`git diff --check` passed; the existing bundle-size warning remains. Independent
read-only review findings were fixed and rechecked. Phase B is complete; later
adjudication, availability, and escrow economics phases remain outside this work.
