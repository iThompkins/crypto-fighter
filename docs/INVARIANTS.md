# Project invariants

These are review gates, not aspirations. A change that intentionally alters one
must update its specification, tests, protocol/version consequences, and the
[decision log](DECISIONS.md) in the same review.

## Game and identity

### INV-01 — One canonical game version

There is one compiled ruleset and one canonical fingerprint at a time. Match
creation cannot negotiate damage, physics, timer, or state encoding. Transcript
metadata describes that version; it does not configure simulation.

Review in: [`src/protocol.ts`](../src/protocol.ts),
[`src/game.ts`](../src/game.ts), and canonical-protocol/contract tests.

### INV-02 — One deterministic cumulative transition

For a valid pre-state and two masks in `0..15`, `transition` determines the only
next state. Browser replay, CLI replay, trace construction, and Solidity one-step
execution must agree on its encoded state hash. A terminal state is absorbing and
consumes no later packet.

Review in: [`src/game.ts`](../src/game.ts),
[`src/protocol.ts`](../src/protocol.ts),
[`contracts/GameTransitionVerifier.sol`](../contracts/GameTransitionVerifier.sol),
and fixed-point/step-adjudication tests.

### INV-03 — Packet signatures prove input authorship, not execution

Each input binds match ID, frame, slot, mask, self-chain head, and delayed opponent
head. Only an admitted contiguous P1/P2 pair advances the game. A valid delayed or
future packet can remain unexecuted and must not be treated as result proof.

Review in: [`src/crypto.ts`](../src/crypto.ts),
[`src/live-match.ts`](../src/live-match.ts), and transcript/live-match tests.

### INV-04 — Genesis carries escrow authority once

Moves remain compact and genesis-bound. Escrow authority comes from one immutable
chain/arena/challenge/participants/sessions/rules/terms binding authorized by both
session keys. A random match ID or self-declared record is not authority.

Review in: [`src/genesis.ts`](../src/genesis.ts),
[`contracts/CryptoFighterArena.sol`](../contracts/CryptoFighterArena.sol), and
[GENESIS_AUTHORIZATION.md](GENESIS_AUTHORIZATION.md).

## Evidence

### INV-05 — Durable commit precedes authority

Outgoing public statements commit before send. Incoming statements commit before
simulation use, acknowledgement, or dependent signing. A failed durable write
stops authority rather than silently continuing. Session private keys are never
persisted or restored.

Review in: [`src/live-match.ts`](../src/live-match.ts),
[`src/evidence-store.ts`](../src/evidence-store.ts), and browser recovery tests.

### INV-06 — Reconstruction uses the whole retained journal

Canonical evidence output is derived from all supplied authenticated READY/input
facts, independent of journal row order, duplicates, local observations, or UI
state. A conflicting signed payload is retained and prevents branch selection;
missing or invalid dependencies produce a non-certifying status.

Review in: [`src/evidence-archive.ts`](../src/evidence-archive.ts),
[`src/evidence-trace.ts`](../src/evidence-trace.ts), and evidence-trace tests.

### INV-07 — Authority modes never collapse

Practice, historical inspection, and independently verified escrow authority are
different modes. A file, flag, embedded chain record, or diagnostic trace cannot
be relabeled into authoritative settlement evidence. All current artifacts remain
`settlementEligible: false`.

Review in: [`src/genesis.ts`](../src/genesis.ts),
[`src/evidence-trace.ts`](../src/evidence-trace.ts), and authorized-trace tests.

### INV-08 — Liveness observations do not assign blame

Disconnects, missing packets, storage failures, retries, and local timestamps do
not prove cheating or a winner. Objective signed faults, liveness failures, and
product/reputation concerns remain separate categories.

Review in: [PHASE_B.md](PHASE_B.md), live-match status transitions, and conflict/
reconnect tests.

## Dispute

### INV-09 — Trace commitments are fixed, bounded, and context-bound

An authorized trace uses checkpoints `0..300`, a depth-nine ordered Merkle tree,
and the immutable genesis binding hash as context. Once a claim/challenge begins,
roots and context do not change. Membership proves inclusion only, not correctness.

Review in: [`src/execution-trace.ts`](../src/execution-trace.ts),
[`contracts/TraceCommitmentVerifier.sol`](../contracts/TraceCommitmentVerifier.sol),
and execution-trace/trace-dispute tests.

### INV-10 — Bisection preserves an equal low and unequal high

Both fixed roots must open the selected midpoint before the bracket moves. Invalid,
duplicate, stale, or late openings do not advance the bracket or restart its clock.
Adjacency is reached within nine rounds for the fixed horizon.

Review in: [`src/bisection.ts`](../src/bisection.ts),
[`contracts/TraceDispute.sol`](../contracts/TraceDispute.sol), and trace-dispute tests.

### INV-11 — One-step adjudication is narrow and neutral

Adjudication authenticates the agreed pre-state, exact frame/slots, both packet
signatures, mask bounds, self/F-2 acknowledgement/frame chains, and both post
openings before executing one transition. It records claimant, challenger, or
neither. It does not certify an entire trace, change reputation, or move funds.

Review in: [`contracts/GameTransitionVerifier.sol`](../contracts/GameTransitionVerifier.sol),
[`contracts/TraceDispute.sol`](../contracts/TraceDispute.sol),
[`src/onchain-dispute.ts`](../src/onchain-dispute.ts), and step-adjudication tests.

### INV-12 — Full transcripts stay off-chain

Solidity receives bounded roots, openings, states, packets, and one-step witnesses;
it never receives or replays a complete match transcript as a fallback.

Review in: [EXECUTION_TRACE.md](EXECUTION_TRACE.md), contract interfaces, and
calldata-building tests.

## Settlement containment

### INV-13 — No current artifact authorizes real funds

Browser settlement transactions are disabled, deployment is restricted to the
in-process Hardhat chain, and neutral trace verdicts have no payout/recovery effect.
Legacy result and timeout payout paths remain unsafe local-only scaffolding and
must not be presented as the current trace protocol.

Review in: [`src/App.tsx`](../src/App.tsx), [`src/chain.ts`](../src/chain.ts),
deployment tests, settlement-disabled tests, and
[PROJECT_COMPLETION.md](PROJECT_COMPLETION.md).

## Required property not yet achieved

Every funded state must eventually have an objective exit that does not require
cooperation from an absent participant. The current trace path does **not** satisfy
this: missed responses and neutral verdicts can leave local test escrow locked.
This is a blocker owned by Issues #4–#6, not a current invariant that the code can
claim to preserve.
