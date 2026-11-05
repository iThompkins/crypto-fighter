# Roadmap

Implemented now: local gameplay, durable evidence, trace adjudication, approved-token
settlement, and same-streak CFC Fibonacci rewards with segregated vaults.

Not implemented: public-chain operations, browser transaction flows, DAO
governance, archive delivery enforcement, or external security review.

The current trace path, removed legacy surface, and unresolved work are
classified in the [protocol-boundary guide](PROTOCOL_BOUNDARY.md).

Deployment stays local-only until production assumptions are implemented,
tested, reviewed, and externally audited.

## Evidence and chain trust

The specification for Issue #5 is in
[`EVIDENCE_AND_CHAIN_TRUST.md`](EVIDENCE_AND_CHAIN_TRUST.md). It defines the
minimum evidence package, separates invalid/unavailable/non-response/uncertain
states, assigns retention responsibilities, and documents configured-RPC,
confirmation, and reorganization assumptions. Backup/hosting features are
optional product work; network defaults and economic consequences remain open.
