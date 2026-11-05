# Project completion handoff

## Current milestone

Local token funding, 24-hour dispute progression, and vault-accounting settlement
now build on completed Phases A–D. The browser and public-chain deployment remain
disabled. The [protocol-boundary guide](PROTOCOL_BOUNDARY.md) classifies the current surface.

## Completed components

- Fixed-point deterministic protocol v2 and canonical ABI state/checkpoint codec.
- Authenticated live lifecycle, durable journals, reconnect, and inspection-only recovery.
- Canonical evidence reconstruction, complete dispute bundles, all openings, and step witnesses.
- Escrow/genesis/session binding and context-bound trace roots.
- On-chain fixed-root claim/challenge and authenticated midpoint bisection.
- Independent Solidity state validation and one-step execution, including terminal absorption.
- Claimant/challenger/neither adjudication with correction and timeout progression.
- CFC and approved-token escrow with pull credits, settled treasury, and prefunded rewards.
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
- A one-step verdict does not certify every other checkpoint; a surviving trace
  receives another response window before terminal settlement.
- Practice, historical inspection, and independently verified escrow authority remain distinct.
- No full transcript is replayed on-chain.
- Browser/CLI artifacts and all trace outputs remain `settlementEligible: false`.
- Deployment and execution remain local-only; no public-chain or real-fund action is authorized.

## Remaining components

- Enforced evidence delivery/availability and recovery beyond local retention/integrity hashes.
- Approved claim replacement, simultaneous dispute, both-invalid, and equivocation consequences.
- Approved chain-finality/reorg trust assumptions for transaction-time record refresh.
- Browser funding/settlement transaction flows and operational monitoring.
- External security review before any relaxation of local-only/funding containment.

## Future policy decisions

- Bonds and challenge-bond economics.
- Penalties, forfeitures, and reputation consequences for direct evidence faults.
- Whether governance should change future-match durations or economic parameters.
- Archive delivery incentives and consequences beyond the current timeout outcome.
- Simultaneous-claim admission beyond the current claimant/opponent sequence.
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

- Journal publication commits only a hash; it supplies no retrieval channel or delivery proof.
- A bisection step resolves the isolated disagreement and does not prove a globally earliest
  invalid transition if arbitrary traces diverge and reconverge.
- The legacy result/timeout payout calls remain removed; the replacement APIs are intentionally incompatible.

## Relevant local commits

- `d758520` — Phase A fixed-point protocol v2 migration.
- `3711a37` — Phase B authenticated live matches and durable evidence.
- `d045537` — Phase C canonical dispute artifacts.
- `f6c734b` — Phase D neutral one-step trace adjudication and witness integration.

## Exact reason the project is not production-complete

The local funded-state exits and ranked streaks are implemented and tested.
Availability operations, client transaction flows, public-chain assumptions,
and external security review remain before production use.
