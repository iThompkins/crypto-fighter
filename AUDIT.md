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
