# Project completion handoff

## Current milestone

Phase D neutral one-step execution adjudication is implemented and locally
verified. Phases A, B, and C remain complete. Funding and settlement are disabled.
The [protocol-boundary guide](PROTOCOL_BOUNDARY.md) classifies current trace,
the removed legacy surface, and unresolved settlement work.

## Completed components

- Fixed-point deterministic protocol v2 and canonical ABI state/checkpoint codec.
- Authenticated live lifecycle, durable journals, reconnect, and inspection-only recovery.
- Canonical evidence reconstruction, complete dispute bundles, all openings, and step witnesses.
- Escrow/genesis/session binding and context-bound trace roots.
- On-chain fixed-root claim/challenge and authenticated midpoint bisection.
- Independent Solidity state validation and one-step execution, including terminal absorption.
- Neutral claimant/challenger/neither adjudication with no payout or reputation effect.
- Separate objective records for signed invalid input and equivocation.
- Participant root-to-journal integrity commitments without availability claims.
- Phase C-to-contract claim, midpoint, and adjudication witness preparation.
- Developer-mode browser witness preparation; the browser has no contract transaction actions.

## Architecture and security invariants

- Signed P1/P2 packets are authoritative input evidence. A trace root is only an execution claim.
- Merkle membership proves commitment inclusion, never checkpoint correctness.
- One-step execution binds the activated match, delegated signers, exact frame and slots,
  input bounds, self chains, F-2 acknowledgement chains, pre-state, frame head, and both roots.
- Terminal trace padding is absorption and consumes no packet.
- A one-step verdict does not certify every other checkpoint or authorize settlement.
- Practice, historical inspection, and independently verified escrow authority remain distinct.
- No full transcript is replayed on-chain.
- Browser/CLI artifacts and all trace outputs remain `settlementEligible: false`.
- Deployment and execution remain local-only; no public-chain or real-fund action is authorized.

## Remaining components

- Policy-approved mapping from neutral verdicts and unchallenged claims to escrow state.
- Authenticated non-response resolution and objective escrow escape.
- Enforced evidence delivery/availability and recovery beyond local retention/integrity hashes.
- Approved claim replacement, simultaneous dispute, both-invalid, and equivocation consequences.
- Approved chain-finality/reorg trust assumptions for transaction-time record refresh.
- Policy and implementation for a safe funded-state exit, without reviving the removed legacy protocols.
- External security review before any relaxation of local-only/funding containment.

## Unresolved policy decisions

- Bonds and challenge-bond economics.
- Payout recipient/split after claimant, challenger, or neither verdict.
- Penalties, forfeitures, and reputation consequences for direct evidence faults.
- Money-governing response and availability timeout durations.
- Disconnect, abandonment, withheld evidence, and lost-key consequences.
- Claim replacement and repeated/simultaneous dispute rules.
- Fees, settlement incentives, and chain-finality/security assumptions.

## Validation run on 2026-10-01

| Command | Result |
| --- | --- |
| `CHROMIUM_PATH=/usr/bin/chromium npm run check` (pre-change baseline) | Pass: 105 Node, 43 contract, 5 browser |
| `npm run lint` | Pass |
| `npm run build` | Pass; existing bundle-size warning |
| `npm test` | Pass: 106/106 |
| `npm run test:contract` | Pass: 51/51 |
| targeted Phase A/one-step contract suite | Pass: 9/9 before archive test addition |
| `CHROMIUM_PATH=/usr/bin/chromium npm run check` (final) | Pass: lint, 106 Node, build, 51 contract, 5 browser |
| `git diff --check` | Pass |

## Known limitations

- A responder who misses a trace deadline has no approved neutral or economic resolution.
- A neutral verdict deliberately leaves local test escrow locked.
- Journal publication commits only a hash; it supplies no retrieval channel or delivery proof.
- A bisection step resolves the isolated disagreement and does not prove a globally earliest
  invalid transition if arbitrary traces diverge and reconverge.
- The legacy result/timeout payout calls are removed; no current API maps a verdict to funds.
- Arena runtime is 17,606 bytes, leaving 6,970 bytes of EIP-170 headroom at current optimizer settings.

## Relevant local commits

- `d758520` — Phase A fixed-point protocol v2 migration.
- `3711a37` — Phase B authenticated live matches and durable evidence.
- `d045537` — Phase C canonical dispute artifacts.
- `f6c734b` — Phase D neutral one-step trace adjudication and witness integration.

## Exact reason the project is not settlement-complete

All deterministic technical work needed to decide an isolated execution step is
implemented. Further escrow behavior requires the unresolved policy decisions
above, which change player incentives and fund safety. No such policy has been
invented in code.
