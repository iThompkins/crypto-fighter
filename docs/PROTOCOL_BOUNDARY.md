# Current protocol boundary

This document is the authoritative guide to the contract and client surfaces
that currently exist. It distinguishes the implemented trace protocol from
unresolved settlement work and records the legacy surface removed in Issue #9.

Current does not mean settlement-safe. The arena is an unaudited, local-chain
prototype, and trace verdicts have no economic effect.

## One deployment, several Solidity source contracts

The separate Solidity files are modules of one arena, not competing arena
contracts:

```text
CryptoFighterArena                 main deployed arena
└── inherits TraceDispute          trace claim, bisection, and neutral verdict
    ├── inherits TraceCommitmentVerifier
    │                              Merkle membership code compiled into the arena
    └── deploys GameTransitionVerifier
                                   separate immutable one-frame rules helper
```

`GameTypes` supplies shared structs. `TraceDispute` and
`TraceCommitmentVerifier` are inherited into `CryptoFighterArena`. The arena
constructor creates one separate `GameTransitionVerifier`; keeping the rules
engine separate avoids the EIP-170 runtime-size limit. The helper has no escrow
or fund-transfer logic.

## Current surfaces

| Surface | Current role |
| --- | --- |
| `challenge`, `join`, `cancelOpenChallenge` | Create, join, or cancel the local test challenge from which an authorized trace context can be formed. Browser transaction controls do not exist. |
| `getGenesisBinding`, `challengeForGenesis`, `authorizeGenesis`, `refundUnactivatedMatch` | Register the completed binding, require both delegated session approvals, and refund both deposits if activation never occurs. |
| `readGenesisRecord`, `verifyGenesisAuthorization`, `createGenesisSession` | Independently read and verify an activated binding before admitting escrow mode. |
| `reconstructEvidence`, `buildEvidenceBundle`, `buildAuthorizedExecutionTrace`, `loadEvidenceDefense` | Rebuild evidence and trace artifacts from a supplied durable journal. Every artifact remains settlement-ineligible. |
| `publishTraceArchive`, `claimTrace`, `challengeTrace`, `revealMidpoint`, `adjudicateStep` | Commit an archive/root, fix two claims, bisect their disagreement, and record `Claimant`, `Challenger`, or `Neither` for one isolated step. None transfers funds. |
| `proveInvalidInput`, `proveEquivocation` | Record objective signed evidence faults separately from the trace verdict. They have no payout or reputation effect. |
| `prepareTraceClaim`, `prepareTraceChallenge`, `prepareMidpointOpening`, `prepareAdjudicationWitness` | Build and validate calldata-shaped witnesses. They do not send transactions. |
| `connectWallet` and the browser's **Escrow evidence** panel | Read and verify an already activated local-chain match. The browser sends no contract transaction. |
| Payout/refund/penalty after a trace verdict, an unchallenged claim, non-response, or unavailable evidence | **Unresolved.** Issues #4 and #5 must specify these rules before implementation. |

## Removed legacy surface

Issue #9 removes the older optimistic result and gameplay-timeout payout
experiment. The following are historical names, not callable compatibility
APIs:

- `claimResult`, `disputeResult`, `finalizeResult`;
- `claimTimeout`, `respondTimeout`, `forfeitTimeout`;
- `Outcome`, result/timeout storage, payout events, `_finalize`, and
  payout-related reputation counters;
- the browser Arena ABI, result mapping, transaction handlers, disabled
  transaction buttons, and historical settlement-payload labels; and
- the legacy settlement behavior tests.

No reverting stubs remain. This is an intentional clean break for a local-only
prototype with no production deployment or persisted-state migration. The
removal does not add a safe exit for activated escrow; that gap remains explicit
work in Issue #4.

## Authoritative current trace path

The current path ends at a neutral fact:

1. `challenge` reserves a fresh match ID and records Player 1's partial offer.
2. `join` supplies Player 2 and replaces the provisional context with the hash
   of the complete `GenesisBinding`.
3. Both session keys approve that completed binding through `authorizeGenesis`.
4. Each browser independently reads the activated arena record before entering
   escrow mode. Practice mode has no arena or escrow authority.
5. Signed READY and input messages are saved before they are sent or used.
6. Reconstruction creates one fixed authorized trace only from complete,
   conflict-free evidence.
7. The arena fixes claimant and challenger roots and bisects an unequal endpoint
   to one transition.
8. `GameTransitionVerifier` recalculates that transition, and the arena records
   `Claimant`, `Challenger`, or `Neither`.
9. The protocol stops. No current function maps that verdict to funds.

A practice archive cannot interact with the arena. Practice and escrow READY
messages use different signed contexts, and the evidence builder rejects giving
a practice archive an authoritative arena record. Individual input packets do
not repeat chain, arena, or stake fields, so a packet alone never proves escrow
authority.

## `matchContextHash` lifecycle

`matchContextHash` is one storage field with two successive meanings. Consumers
must also check challenge and authorization state.

| Lifecycle point | Stored value | Allowed reliance |
| --- | --- | --- |
| After `challenge`, before `join` | Provisional hash of chain, arena, challenge, P1, stake, match ID, rules, P1 session, and response window. | Correlation only. P2 and the completed binding do not exist. |
| After `join`, before `authorizeGenesis` | Hash of the complete immutable `GenesisBinding`. | The session keys may authorize it, but it is not activated. |
| After `authorizeGenesis` | The same completed binding hash plus a separate true authorization flag. | Independently verified escrow admission and current trace context. |
| After cancellation or unactivated refund | Bytes remain reserved for history. | Historical inspection only; status gates reject current use. |
| After trace resolution | The challenge remains active and the trace records a neutral verdict. | Evidence inspection only; no payout or refund follows. |

Use **provisional challenge context**, **completed binding hash**, and
**authorized genesis context** for those stages. Do not call the completed
binding a finalized or settled match.

## Names that are easy to misread

| Name | Meaning | It does not mean |
| --- | --- | --- |
| `matchId` / `genesis` | The same fresh bytes32 anchor, named from packet and binding viewpoints. | Contract authority by itself. |
| `GenesisBinding` | Complete match/escrow terms whose hash contextualizes compact moves. | An approved result or payout. |
| `genesisAuthorized` | Both delegated session keys approved the completed binding on the arena. | Settlement eligibility or proof every input executed. |
| `settlementEligible: false` | An explicit client-artifact safety marker. | A switch callers may change to gain authority. |
| `claimTrace` / `TraceClaimed` | A current commitment to a trace root and endpoint. | A payout request or proof the entire trace is correct. |
| claimant / challenger | Roles determined by root submission order. | Player 1/Player 2, winner/loser, or beneficiary/forfeiter. |
| `StepVerdict` | Which proposed post-checkpoint matches one canonical transition. | A match outcome, fraud judgment, penalty, or fund destination. |
| Merkle “proof” | Proof a checkpoint belongs to a submitted root. | Proof the checkpoint follows the game rules. |
| transcript `final` | The end of reconstructed gameplay. | Settled funds. |

## Unresolved policy

[Issue #5](https://github.com/iThompkins/crypto-fighter/issues/5) owns evidence
availability and chain trust assumptions. [Issue #4](https://github.com/iThompkins/crypto-fighter/issues/4)
owns safe settlement and funded-state exit semantics. Neither may treat removed
legacy behavior as an implicit default.
