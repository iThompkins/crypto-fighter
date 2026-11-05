# Roadmap

Implemented now: local gameplay, durable evidence, trace comparison, and neutral
one-step adjudication.

Not implemented: safe settlement.

The current trace path, removed legacy surface, and unresolved work are
classified in the [protocol-boundary guide](PROTOCOL_BOUNDARY.md).

Future policy work is tracked in [Issue #5](https://github.com/iThompkins/crypto-fighter/issues/5)
and [Issue #4](https://github.com/iThompkins/crypto-fighter/issues/4). Until that
work is specified, implemented, tested, and reviewed, settlement stays disabled
and deployment stays local-only.

## Evidence and chain trust

The specification for Issue #5 is in
[`EVIDENCE_AND_CHAIN_TRUST.md`](EVIDENCE_AND_CHAIN_TRUST.md). It defines the
minimum evidence package, separates invalid/unavailable/non-response/uncertain
states, assigns retention responsibilities, and documents configured-RPC,
confirmation, and reorganization assumptions. Backup/hosting features are
optional product work; network defaults and economic consequences remain open.
