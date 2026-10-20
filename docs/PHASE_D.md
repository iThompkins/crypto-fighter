# Phase D: neutral one-step execution adjudication

Phase D completes the technically deterministic portion of a disputed trace.
It does not decide who receives funds, impose penalties, resolve missed dispute
turns, or enable settlement.

## Contract flow

1. `claimTrace` fixes the claimant root, authenticated escrow context, canonical
   genesis opening, horizon endpoint, terminal state metadata, and deadline.
2. `challengeTrace` fixes the opponent root under the same context, proves the
   same genesis, and requires a different horizon endpoint.
3. Both participants open each selected midpoint. The bracket preserves an
   equal lower checkpoint and unequal upper checkpoints until they are adjacent.
4. `adjudicateStep` verifies the claimant-root lower opening and both root-specific
   upper openings. The lower state bytes must hash to the agreed checkpoint.
5. For an execution step, the immutable rules verifier checks the two session
   signatures, match, frame, slots, input masks, self links, F-2 opponent links,
   and computes the canonical frame head, next state, and checkpoint. For an
   already terminal state, the only canonical result is the unchanged checkpoint.
6. The resulting checkpoint is compared with the two committed upper hashes.
   The stored verdict is `Claimant`, `Challenger`, or `Neither`.

The post-state itself need not be supplied: its canonical Solidity encoding and
hash are computed from the authenticated pre-state and inputs, then compared to
the state hash inside each committed post-checkpoint. Merkle membership proves
only what each party committed. Execution determines whether either commitment
matches the rules.

## Deployment split

Inlining the rules engine made the arena runtime 27,070 bytes, above the 24,576
byte EIP-170 limit. The arena now creates one immutable `GameTransitionVerifier`
in its constructor and calls it for pure state/signature work. Verified optimized
runtime sizes are 23,739 bytes for the arena and 7,995 bytes for the verifier;
the arena initcode is 31,987 bytes. The existing constructor and deployment
script still restrict use to the in-process local chain.

## Evidence and availability

`src/onchain-dispute.ts` accepts only a Phase C bundle rebuilt with a freshly
read independent genesis record. It can prepare root-claim, challenge, midpoint,
and isolated-step tuples. For the isolated step it verifies the context, all
three supplied openings, their indices, and equality of the evidence-derived and
claimant-committed pre-checkpoint before returning calldata fields.

`publishTraceArchive` lets a participant bind a root to the Phase C `journalHash`.
This makes replacement of a retrieved archive detectable. It does not publish
the archive, prove another party received it, or decide what withholding means.
The browser retains and exports complete bundles and can prepare calldata in
developer mode. It does not send dispute or settlement transactions.

Signed invalid input and two distinct signed packets for one match/player/frame
are objective evidence faults. They are stored separately from trace execution
verdicts. Duplicate proofs are rejected. Neither kind changes funds, statistics,
or the dispute verdict.

## Remaining policy boundary

Technical execution is no longer the blocker. The following decisions have
materially different consequences for players and funds and remain intentionally
unimplemented:

- what a claimant, challenger, or neither verdict does to the escrow;
- whether a valid isolated step is enough to replace a claimed result, or only
  to reject one root;
- consequences for equivocation, invalid signed input, or both-invalid traces;
- which participant owes each response, consequences of non-response, and any
  money-governing timeout duration;
- claim replacement and simultaneous or repeated dispute rules;
- what availability commitment/delivery mechanism is required and what happens
  when evidence is withheld or lost;
- canonical-chain finality/reorg assumptions for fresh activation checks;
- bonds, fees, forfeitures, payout splits, reputation, and settlement incentives.

Until those are approved, trace verdicts are neutral facts, legacy payout paths
remain unsafe local scaffolding, every client artifact says
`settlementEligible: false`, and browser settlement stays disabled.
