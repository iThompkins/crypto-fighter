# Decision log

This log records durable choices that explain the current architecture. It does
not duplicate full specifications and does not turn unresolved roadmap questions
into decisions.

## Entry format

Each entry has an ID, date, status (`Accepted`, `Superseded`, or `Revisit`), the
decision in plain language, its practical consequence, and links to authoritative
context. New entries should be short. If a decision changes, add a new entry and
mark the old one `Superseded`; do not erase the history.

## D-001 — Keep settlement local and visibly disabled

- **Date:** 2026-09-16
- **Status:** Accepted
- **Decision:** Browser settlement transactions stay disabled and deployment is
  restricted to the in-process Hardhat chain until the security model is complete.
- **Consequence:** Passing local tests does not authorize public deployment or
  real funds. Chain ID 31337 is containment, not proof of safety.
- **Context:** [AUDIT.md](../AUDIT.md), [README safety limitations](../README.md#safety-limitations)

## D-002 — Use optimistic Merkle traces and minimal on-chain execution

- **Date:** 2026-09-16
- **Status:** Accepted
- **Decision:** Commit off-chain execution as an ordered Merkle trace, resolve
  disagreements with interactive bisection, and execute only the isolated step
  on-chain. Never replay a complete transcript in Solidity.
- **Consequence:** Data availability and monitoring are security requirements;
  Merkle membership alone never proves execution.
- **Context:** [EXECUTION_TRACE.md](EXECUTION_TRACE.md)

## D-003 — Use one canonical fixed-point game version

- **Date:** 2026-09-17
- **Status:** Accepted
- **Decision:** Protocol v2 uses SCALE=256 integer geometry and nearest-midpoint
  rounding with ties to even. One fingerprint identifies the compiled ruleset;
  matches do not negotiate gameplay parameters.
- **Consequence:** Old transcript/root formats are rejected rather than relabeled,
  and browser, CLI, evidence, and Solidity share the same state bytes.
- **Context:** [FIXED_POINT_PROTOCOL.md](FIXED_POINT_PROTOCOL.md)

## D-004 — Bind compact move signatures through an authorized genesis

- **Date:** 2026-09-17
- **Status:** Accepted
- **Decision:** A fresh match ID is permanently registered to one immutable
  chain/arena/challenge/participants/sessions/rules/escrow binding authorized once
  by both session keys. Individual move digests remain compact and genesis-bound.
- **Consequence:** A random nonce or move signature alone has no escrow authority;
  practice evidence remains non-contractual, while escrow evidence requires the
  complete authorization and independent arena record.
- **Context:** [GENESIS_AUTHORIZATION.md](GENESIS_AUTHORIZATION.md),
  [protocol boundary](PROTOCOL_BOUNDARY.md#authoritative-current-trace-path)

## D-005 — Separate objective faults, liveness, and behavior policy

- **Date:** 2026-09-18
- **Status:** Accepted
- **Decision:** Invalid signed facts/proofs, missing/disconnected participants, and
  product/reputation concerns are different categories. Liveness observations do
  not automatically prove cheating or choose a winner.
- **Consequence:** Timeouts and eventual funded exits require explicit policy;
  local timestamps or disconnect events cannot silently gain financial authority.
- **Context:** [PHASE_B.md](PHASE_B.md#policy-boundary)

## D-006 — Derive dispute artifacts from the complete durable journal

- **Date:** 2026-09-18
- **Status:** Accepted
- **Decision:** Canonical evidence reconstruction authenticates every supplied
  READY/input fact and never exposes a parameter for choosing among conflicting
  signed branches. Browser and CLI derive dispute bundles from that reconstruction.
- **Consequence:** Conflicts, invalid chains, and missing dependencies remain
  visible non-certifying outcomes; a selected transcript cannot hide them.
- **Context:** [PHASE_C.md](PHASE_C.md)

## D-007 — Keep one-step adjudication neutral

- **Date:** 2026-10-01
- **Status:** Accepted
- **Decision:** After bisection, Solidity records whether the canonical isolated
  step matches the claimant, challenger, or neither commitment. That verdict does
  not transfer funds, change reputation, or certify an entire trace.
- **Consequence:** Deterministic execution is complete without inventing economic
  consequences. Settlement waits for explicit policy decisions in Issues #4 and
  #5; the current/legacy API boundary is documented separately.
- **Context:** [PHASE_D.md](PHASE_D.md), [PROJECT_COMPLETION.md](PROJECT_COMPLETION.md),
  [protocol boundary](PROTOCOL_BOUNDARY.md#entry-point-classification)
