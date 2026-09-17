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
