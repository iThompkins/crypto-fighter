# Project invariants

These are review rules for the system that exists today. If a change deliberately
breaks one, update the relevant specification, tests, versioning consequences,
and [decision log](DECISIONS.md) in the same review.

## INV-01 — One game version defines every match

**Rule —** A match uses the one compiled ruleset and fingerprint. Players cannot
negotiate different damage, movement, timer, or state encoding.

**Why —** If rules were configurable or only descriptive, two honest programs
could accept the same match while calculating different states.

**Enforced by —** [`src/protocol.ts`](../src/protocol.ts),
[`src/game.ts`](../src/game.ts),
[`test/canonical-protocol.test.mjs`](../test/canonical-protocol.test.mjs), and
[`hh/test/canonical-rules.cjs`](../hh/test/canonical-rules.cjs).

## INV-02 — The same state and inputs always produce the same next state

**Rule —** For a valid state and two input masks from 0 to 15, there is exactly
one next state. Browser replay, trace construction, and Solidity must agree on
its encoded hash. Once a match ends, later trace positions repeat the final state
without consuming more inputs.

**Why —** A dispute cannot be resolved if different components calculate
different movement, damage, clocks, or end states.

**Enforced by —** [`src/game.ts`](../src/game.ts),
[`src/protocol.ts`](../src/protocol.ts),
[`contracts/GameTransitionVerifier.sol`](../contracts/GameTransitionVerifier.sol),
[`test/fixed-point.test.mjs`](../test/fixed-point.test.mjs), and
[`hh/test/fixed-point-codec.cjs`](../hh/test/fixed-point-codec.cjs).

## INV-03 — A packet signature proves authorship, not execution

**Rule —** An input packet binds its match, frame, player, input, previous own
packet, and older opponent packet. Only the next valid Player 1/Player 2 pair
advances play. A valid packet signed ahead of time is not proof that its frame ran.

**Why —** Treating any signed future packet as executed would allow delayed or
unused inputs to manufacture a result or overturn a real one.

**Enforced by —** [`src/crypto.ts`](../src/crypto.ts),
[`src/live-match.ts`](../src/live-match.ts),
[`test/live-match.test.mjs`](../test/live-match.test.mjs), and
[`test/transcript-integrity.test.mjs`](../test/transcript-integrity.test.mjs).

## INV-04 — Both session keys authorize one completed match binding

**Rule —** The short match ID gains escrow meaning only through one immutable
`GenesisBinding` containing the chain, arena, challenge, players, sessions, rules,
and terms. Both session keys must approve the completed binding.

**Why —** A random match ID or self-declared file must not be able to attach
ordinary practice inputs to a funded match after the fact.

**Enforced by —** [`src/genesis.ts`](../src/genesis.ts),
[`contracts/CryptoFighterArena.sol`](../contracts/CryptoFighterArena.sol),
[`test/genesis-authorization.test.mjs`](../test/genesis-authorization.test.mjs),
and [`hh/test/genesis.cjs`](../hh/test/genesis.cjs).

## INV-05 — Persistent storage completes before a message gains authority

**Rule —** An outgoing public statement is saved before it is sent. An incoming
statement is saved before it is acknowledged, used in the simulation, or used to
sign a dependent packet. Failed storage stops play. Session private keys are
never persisted or restored.

**Why —** Otherwise a crash or reload could erase the evidence for an action the
peer already relied on, or restore signing power that should have disappeared.

**Enforced by —** [`src/live-match.ts`](../src/live-match.ts),
[`src/evidence-store.ts`](../src/evidence-store.ts),
[`test/live-match.test.mjs`](../test/live-match.test.mjs), and
[`test/browser/live-evidence.spec.mjs`](../test/browser/live-evidence.spec.mjs).

## INV-06 — Reconstruction examines the entire supplied journal

**Rule —** Derived transcripts and traces come from all supplied authenticated
READY and input facts, regardless of row order, duplicates, UI state, or which
browser saved them. Conflicting signed packets prevent selection of either branch;
missing or broken dependencies remain visible.

**Why —** A participant must not be able to hide inconvenient signed evidence by
exporting only the branch that supports its claim.

**Enforced by —** [`src/evidence-archive.ts`](../src/evidence-archive.ts),
[`src/evidence-trace.ts`](../src/evidence-trace.ts), and
[`test/evidence-trace.test.mjs`](../test/evidence-trace.test.mjs).

## INV-07 — Practice evidence cannot become funded-match evidence

**Rule —** Practice artifacts, saved historical records, and a freshly verified
authorized arena record remain distinct. A flag or imported file cannot promote
one category into another. Every current artifact still states
`settlementEligible: false`.

**Why —** Otherwise a self-authored or stale file could claim the authority of a
live funded match without proving the arena actually authorized it.

**Enforced by —** [`src/genesis.ts`](../src/genesis.ts),
[`src/evidence-trace.ts`](../src/evidence-trace.ts),
[`src/onchain-dispute.ts`](../src/onchain-dispute.ts), and
[`test/authorized-trace.test.mjs`](../test/authorized-trace.test.mjs).

## INV-08 — Disconnects and missing messages do not prove a cheater or winner

**Rule —** Local timestamps, disconnects, missing packets, retries, and storage
failures may stop progress, but they do not by themselves assign fault or choose
a winner.

**Why —** Either peer, the network, storage, or the application could cause the
same observation. Turning it directly into punishment would let unreliable local
conditions decide money.

**Enforced by —** [`src/live-match.ts`](../src/live-match.ts),
[`src/match-evidence.ts`](../src/match-evidence.ts),
[`test/match-evidence.test.mjs`](../test/match-evidence.test.mjs), and
[`test/browser/live-evidence.spec.mjs`](../test/browser/live-evidence.spec.mjs).

## INV-09 — A trace is fixed, bounded, and tied to one match binding

**Rule —** An authorized trace contains checkpoints 0 through 300 and commits
them under the completed `GenesisBinding` hash. Submitted roots and their match
context do not change during a dispute. A Merkle proof shows membership only; it
does not show that a checkpoint is correct.

**Why —** Changing the root, range, or match halfway through comparison would
make midpoint answers meaningless, while treating membership as truth would skip
actual game-rule verification.

**Enforced by —** [`src/execution-trace.ts`](../src/execution-trace.ts),
[`contracts/TraceCommitmentVerifier.sol`](../contracts/TraceCommitmentVerifier.sol),
[`test/execution-trace.test.mjs`](../test/execution-trace.test.mjs), and
[`hh/test/trace-dispute.cjs`](../hh/test/trace-dispute.cjs).

## INV-10 — Each bisection round preserves the boundary of the disagreement

**Rule —** Both players must prove their checkpoint at the same midpoint before
the range moves. After each round, the lower checkpoint is one they agree on and
the upper checkpoint is one they disagree on. Invalid, duplicate, stale, or late
answers do not move the range or restart its clock.

**Why —** Without these rules, one player could steer the search away from the
first disputed transition or extend the dispute indefinitely.

**Enforced by —** [`src/bisection.ts`](../src/bisection.ts),
[`contracts/TraceDispute.sol`](../contracts/TraceDispute.sol),
[`test/authorized-trace.test.mjs`](../test/authorized-trace.test.mjs), and
[`hh/test/trace-dispute.cjs`](../hh/test/trace-dispute.cjs).

## INV-11 — One-step adjudication checks only the isolated step

**Rule —** Adjudication verifies the agreed pre-step state, exact frame and slots,
both packet signatures, input bounds, packet-history links, and both proposed
post-step checkpoints before running one transition. It records claimant,
challenger, or neither; it does not validate every other trace step or move funds.

**Why —** A correct isolated step is enough to resolve that disagreement, but it
cannot safely be stretched into proof of an entire trace or an economic policy.

**Enforced by —** [`contracts/GameTransitionVerifier.sol`](../contracts/GameTransitionVerifier.sol),
[`contracts/TraceDispute.sol`](../contracts/TraceDispute.sol),
[`src/onchain-dispute.ts`](../src/onchain-dispute.ts), and
[`hh/test/step-adjudication.cjs`](../hh/test/step-adjudication.cjs).

## INV-12 — Complete transcripts stay off-chain

**Rule —** Contracts receive roots, short Merkle proofs, states, packets, and one
step witness. They never accept or replay a full match transcript as a fallback.

**Why —** Full on-chain replay would discard the project's bounded-dispute model
and make cost grow with match length.

**Enforced by —** [`contracts/TraceCommitmentVerifier.sol`](../contracts/TraceCommitmentVerifier.sol),
[`contracts/TraceDispute.sol`](../contracts/TraceDispute.sol),
[`src/onchain-dispute.ts`](../src/onchain-dispute.ts), and
[`hh/test/step-adjudication.cjs`](../hh/test/step-adjudication.cjs).

## INV-13 — Current trace verdicts never authorize real funds

**Rule —** Browser settlement actions remain disabled, deployment remains limited
to the in-process Hardhat chain, and a trace verdict has no payout or refund
effect. Legacy result and timeout functions are unsafe local scaffolding, not the
trace settlement path.

**Why —** The project still lacks economic rules, non-response handling, evidence
availability guarantees, and an objective exit from every funded state.

**Enforced by —** [`src/App.tsx`](../src/App.tsx),
[`src/chain.ts`](../src/chain.ts),
[`contracts/TraceDispute.sol`](../contracts/TraceDispute.sol),
[`test/settlement-disabled.test.mjs`](../test/settlement-disabled.test.mjs), and
[`hh/test/deployment.cjs`](../hh/test/deployment.cjs).

## Missing property

Every funded state should eventually have a safe, objective exit even if one
participant disappears. The current trace path does not provide that guarantee:
silence and a `neither` verdict can leave local test escrow locked. This is future
settlement work, not a property the current code can claim.
