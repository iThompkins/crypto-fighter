# Project invariants

These are rules that the current system depends on. A change that intentionally
breaks one must update the relevant specification, tests, versioning, and
[decision log](DECISIONS.md) in the same review.

## INV-01 — One game version defines every match

**Rule:** A match uses the one compiled ruleset and fingerprint. Players cannot
choose different movement, damage, timing, or state encoding.

**Why it matters:** Two honest programs must calculate the same match.

**Where it is enforced/tested:** [`src/protocol.ts`](../src/protocol.ts),
[`src/game.ts`](../src/game.ts),
[`test/canonical-protocol.test.mjs`](../test/canonical-protocol.test.mjs), and
[`hh/test/canonical-rules.cjs`](../hh/test/canonical-rules.cjs).

## INV-02 — The same state and inputs have one next state

**Rule:** A valid state and two valid button values produce exactly one next
state. Browser replay, trace creation, and Solidity must agree. After the match
ends, later trace checkpoints repeat the final state without consuming inputs.

**Why it matters:** A dispute is impossible to resolve if components calculate
different game results.

**Where it is enforced/tested:** [`src/game.ts`](../src/game.ts),
[`contracts/GameTransitionVerifier.sol`](../contracts/GameTransitionVerifier.sol),
[`test/fixed-point.test.mjs`](../test/fixed-point.test.mjs), and
[`hh/test/fixed-point-codec.cjs`](../hh/test/fixed-point-codec.cjs).

## INV-03 — A packet signature proves authorship, not play

**Rule:** A signed input packet proves that a session key made that statement.
Only the next valid pair of Player 1 and Player 2 packets advances the game.

**Why it matters:** A packet can be signed ahead of time and never used. Treating
it as played could create or overturn a result.

**Where it is enforced/tested:** [`src/crypto.ts`](../src/crypto.ts),
[`src/live-match.ts`](../src/live-match.ts),
[`test/live-match.test.mjs`](../test/live-match.test.mjs), and
[`test/transcript-integrity.test.mjs`](../test/transcript-integrity.test.mjs).

## INV-04 — Both session keys approve the completed match

**Rule:** A match ID receives escrow meaning only through one complete,
unchangeable `GenesisBinding` approved by both session keys.

**Why it matters:** A practice archive or random match ID has no contract
authority. Funded evidence must belong to terms both sessions approved and an
independently verified arena record.

**Where it is enforced/tested:** [`src/genesis.ts`](../src/genesis.ts),
[`contracts/CryptoFighterArena.sol`](../contracts/CryptoFighterArena.sol),
[`test/genesis-authorization.test.mjs`](../test/genesis-authorization.test.mjs),
and [`hh/test/genesis.cjs`](../hh/test/genesis.cjs).

The provisional, completed, and authorized context states are distinguished in
the [protocol-boundary guide](PROTOCOL_BOUNDARY.md#matchcontexthash-lifecycle).

## INV-05 — Save a message before sending or using it

**Rule:** An outgoing public message is saved before it is sent. An incoming
message is saved before it affects play or another signature. Storage failure
stops play, and session private keys are never saved.

**Why it matters:** A crash must not erase evidence that the other player already
relied on.

**Where it is enforced/tested:** [`src/live-match.ts`](../src/live-match.ts),
[`src/evidence-store.ts`](../src/evidence-store.ts),
[`test/live-match.test.mjs`](../test/live-match.test.mjs), and
[`test/browser/live-evidence.spec.mjs`](../test/browser/live-evidence.spec.mjs).

## INV-06 — Reconstruction uses the whole supplied journal

**Rule:** Reconstruction checks every supplied READY and input message,
regardless of storage order or duplicates. Conflicting signed packets stop it
from selecting either history.

**Why it matters:** A player must not hide inconvenient evidence and export only
the history that supports a claim.

**Where it is enforced/tested:** [`src/evidence-archive.ts`](../src/evidence-archive.ts),
[`src/evidence-trace.ts`](../src/evidence-trace.ts), and
[`test/evidence-trace.test.mjs`](../test/evidence-trace.test.mjs).

## INV-07 — Practice evidence cannot become funded-match evidence

**Rule:** Practice matches, saved historical records, and a freshly verified
arena record remain different kinds of evidence. An imported file or flag cannot
promote one into another. Current artifacts say `settlementEligible: false`.

**Why it matters:** A self-authored, practice, or stale file must not gain the
authority of a live funded match.

**Where it is enforced/tested:** [`src/genesis.ts`](../src/genesis.ts),
[`src/evidence-trace.ts`](../src/evidence-trace.ts),
[`src/onchain-dispute.ts`](../src/onchain-dispute.ts), and
[`test/authorized-trace.test.mjs`](../test/authorized-trace.test.mjs).

## INV-08 — A disconnect does not prove fault or a winner

**Rule:** Disconnects, missing messages, retries, timestamps, and storage failures
may stop progress, but they do not assign blame or choose a winner.

**Why it matters:** The same symptom can be caused by either player, the network,
storage, or the application.

**Where it is enforced/tested:** [`src/live-match.ts`](../src/live-match.ts),
[`src/match-evidence.ts`](../src/match-evidence.ts),
[`test/match-evidence.test.mjs`](../test/match-evidence.test.mjs), and
[`test/browser/live-evidence.spec.mjs`](../test/browser/live-evidence.spec.mjs).

## INV-09 — A trace is fixed and belongs to one match

**Rule:** An authorized trace has checkpoints 0 through 300 and is tied to the
completed `GenesisBinding`. Roots and match context cannot change during a
dispute. A Merkle proof proves membership, not correctness.

**Why it matters:** Midpoint comparisons are meaningless if a player can change
the timeline or match while the dispute is running.

**Where it is enforced/tested:** [`src/execution-trace.ts`](../src/execution-trace.ts),
[`contracts/TraceCommitmentVerifier.sol`](../contracts/TraceCommitmentVerifier.sol),
[`test/execution-trace.test.mjs`](../test/execution-trace.test.mjs), and
[`hh/test/trace-dispute.cjs`](../hh/test/trace-dispute.cjs).

## INV-10 — Bisection keeps an agreed lower checkpoint and a disputed upper one

**Rule:** Both players reveal the same requested midpoint before the range moves.
Equal answers move the lower end; different answers move the upper end. Invalid,
duplicate, stale, or late answers do not move the range or restart its clock.

**Why it matters:** A player must not steer the search away from the isolated
disagreement or extend it indefinitely.

**Where it is enforced/tested:** [`src/bisection.ts`](../src/bisection.ts),
[`contracts/TraceDispute.sol`](../contracts/TraceDispute.sol),
[`test/authorized-trace.test.mjs`](../test/authorized-trace.test.mjs), and
[`hh/test/trace-dispute.cjs`](../hh/test/trace-dispute.cjs).

## INV-11 — Adjudication checks only the isolated step

**Rule:** The contract verifies the agreed state and both proposed next
checkpoints. For a nonterminal state, it also verifies the two authorized input
packets and runs one game transition. It records `Claimant`, `Challenger`, or
`Neither`; it does not move funds.

**Why it matters:** One correct step resolves that local disagreement but does
not prove an entire trace or define economic consequences.

**Where it is enforced/tested:**
[`contracts/GameTransitionVerifier.sol`](../contracts/GameTransitionVerifier.sol),
[`contracts/TraceDispute.sol`](../contracts/TraceDispute.sol),
[`src/onchain-dispute.ts`](../src/onchain-dispute.ts), and
[`hh/test/step-adjudication.cjs`](../hh/test/step-adjudication.cjs).

## INV-12 — Complete match histories stay off-chain

**Rule:** Contracts receive roots, short proofs, checkpoints, and the evidence
for one step. They do not accept or replay a complete match history.

**Why it matters:** On-chain work must remain bounded instead of growing with
the length of the match.

**Where it is enforced/tested:**
[`contracts/TraceCommitmentVerifier.sol`](../contracts/TraceCommitmentVerifier.sol),
[`contracts/TraceDispute.sol`](../contracts/TraceDispute.sol),
[`src/onchain-dispute.ts`](../src/onchain-dispute.ts), and
[`hh/test/step-adjudication.cjs`](../hh/test/step-adjudication.cjs).

## INV-13 — Trace verdicts do not authorize real funds

**Rule:** The browser sends no contract transactions, deployment remains limited
to the in-process Hardhat chain, and a trace verdict has no payout or refund
effect. The older payout functions have been removed.

**Why it matters:** Settlement rules, evidence availability, non-response, and a
safe exit from every funded state have not been solved.

**Where it is enforced/tested:** [`src/App.tsx`](../src/App.tsx),
[`src/chain.ts`](../src/chain.ts),
[`contracts/TraceDispute.sol`](../contracts/TraceDispute.sol),
[`hh/test/match-lifecycle.cjs`](../hh/test/match-lifecycle.cjs), and
[`hh/test/deployment.cjs`](../hh/test/deployment.cjs).

## Important missing guarantee

Every funded state should eventually have a safe, objective exit, even if one
player disappears. The current trace path does not provide that guarantee.
Silence or a `Neither` verdict can leave local test escrow locked.

## INV-14 — Evidence properties and failure states remain distinct

**Rule:** Authenticity, integrity, availability, and canonical-chain inclusion
are checked separately. Missing or withheld evidence is not relabeled invalid,
and it cannot become a `Neither` execution verdict. Unavailable evidence,
non-response, and objective signed faults remain distinct facts. A disclosed
settlement policy may still assign several failures the same timeout outcome.

**Why it matters:** A signature or hash does not deliver its preimage, while
failure to retrieve data does not prove that data false. The distinction keeps
the protocol honest about what happened without requiring it to prove motive or
eliminate ordinary availability risk.

**Where it is specified/enforced:**
[`EVIDENCE_AND_CHAIN_TRUST.md`](EVIDENCE_AND_CHAIN_TRUST.md),
[`src/evidence-archive.ts`](../src/evidence-archive.ts),
[`src/evidence-trace.ts`](../src/evidence-trace.ts), and
[`contracts/TraceDispute.sol`](../contracts/TraceDispute.sol). External delivery
and economic consequences are not yet enforced.

## INV-15 — RPC and confirmation trust is explicit

**Rule:** The client may rely on its configured RPC after the published
network-specific confirmation rule is met. Users who want stronger assurance
may choose another provider or run their own node. After a reorg, clients reload
arena state and ignore actions that existed only on the discarded fork.

**Why it matters:** Provider and recent-chain risk cannot be eliminated for every
user. The community needs to know the default trust and recovery behavior so
players can choose the assurance level appropriate for them.

**Where it is specified/enforced:**
[`EVIDENCE_AND_CHAIN_TRUST.md`](EVIDENCE_AND_CHAIN_TRUST.md) and
[`src/genesis.ts`](../src/genesis.ts). The current client pins one provider read;
production confirmation defaults and reorg recovery remain unimplemented, so
deployment remains local-only.
