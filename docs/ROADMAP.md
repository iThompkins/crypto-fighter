# Roadmap

Implemented now: local gameplay, durable evidence, trace comparison, and neutral
one-step adjudication.

Specified but not implemented: safe settlement.

The current trace path, removed legacy surface, and unresolved work are
classified in the [protocol-boundary guide](PROTOCOL_BOUNDARY.md).

Evidence/chain assumptions are specified in Issue #5, and funded-state exits are
specified in [`SETTLEMENT_POLICY.md`](SETTLEMENT_POLICY.md) for Issue #4. CFC
monetary and ranked-reward policy remains in Issue #12. Until the dependent
implementation is tested and reviewed, settlement stays disabled and deployment
stays local-only.

## Evidence and chain trust

The specification for Issue #5 is in
[`EVIDENCE_AND_CHAIN_TRUST.md`](EVIDENCE_AND_CHAIN_TRUST.md). It defines the
minimum evidence package, separates invalid/unavailable/non-response/uncertain
states, assigns retention responsibilities, and documents configured-RPC,
confirmation, and reorganization assumptions. Backup/hosting features are
optional product work; network defaults and economic consequences remain open.
