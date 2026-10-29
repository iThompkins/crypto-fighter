# Current and legacy protocol boundary

This document classifies the settlement- and dispute-related code that exists in
the repository. It is the authoritative guide to whether a name or entry point
belongs to the current trace protocol, legacy local scaffolding, a disabled
client path, or unresolved future settlement work.

The classification describes current code. It does not approve real-fund use,
choose settlement policy, or promise compatibility for a future protocol.

## Status words

- **Current trace protocol:** implemented and tested machinery used to authorize
  a match, reconstruct evidence, commit traces, isolate one transition, or record
  a neutral technical verdict. Current does not mean settlement-safe.
- **Legacy settlement:** older local-only result or timeout machinery that can
  move Hardhat test funds without the guarantees required by the trace design.
  It must not define future settlement behavior.
- **Compatibility-only:** code or tests retained to describe, contain, or prevent
  accidental interaction with an existing legacy surface. Passing these tests is
  not an endorsement of that surface.
- **Disabled:** code remains visible, but the browser or deployment boundary
  prevents its transaction path from being used.
- **Unresolved:** policy or migration work that has not been approved or
  implemented.

## One deployment, several Solidity source contracts

The separate Solidity files do not represent several competing arenas:

```text
CryptoFighterArena                 main deployed arena
└── inherits TraceDispute          trace claim, bisection, and neutral verdict
    ├── inherits TraceCommitmentVerifier
    │                              Merkle membership code compiled into the arena
    └── deploys GameTransitionVerifier
                                   separate immutable one-frame rules helper
```

`GameTypes` only supplies shared structs. `TraceDispute` is abstract and is
compiled into `CryptoFighterArena`. `TraceCommitmentVerifier` is inherited code,
not a separately deployed dependency in the normal deployment. The arena
constructor creates one separate `GameTransitionVerifier` because inlining the
rules engine would exceed the EIP-170 runtime-size limit.

The normal deployment script deploys `CryptoFighterArena`; that deployment then
creates its verifier. The arena constructor and deployment script restrict this
combined deployment to the in-process Hardhat chain. The helper has no escrow or
fund-transfer logic and is not independently deployed by the script.

## Entry-point classification

| Surface | Status | Current interpretation |
| --- | --- | --- |
| `challenge`, `join`, `cancelOpenChallenge` | **Current trace protocol, shared lifecycle** | Create or cancel the local test challenge from which an authorized trace context can later be formed. They also predate the trace flow, so their existence does not make the legacy payout path current. Browser transaction controls remain disabled. |
| `getGenesisBinding`, `challengeForGenesis`, `authorizeGenesis`, `refundUnactivatedMatch` | **Current trace protocol** | Register the completed binding, require both delegated session approvals, and refund both deposits if activation never occurs. |
| `readGenesisRecord`, `verifyGenesisAuthorization`, `createGenesisSession` | **Current trace protocol** | Independently read and verify the authorized binding and prevent the escrow signer from producing moves before activation. |
| `reconstructEvidence`, `buildEvidenceBundle`, `buildAuthorizedExecutionTrace`, `loadEvidenceDefense` | **Current trace protocol** | Rebuild current evidence and dispute artifacts from the supplied durable journal. Every artifact remains settlement-ineligible. |
| `publishTraceArchive`, `claimTrace`, `challengeTrace`, `revealMidpoint`, `adjudicateStep` | **Current trace protocol** | Commit a journal hash/root, fix two trace claims, bisect their disagreement, and record `Claimant`, `Challenger`, or `Neither` for one isolated step. None transfers funds. |
| `proveInvalidInput`, `proveEquivocation` | **Current trace protocol** | Record objective signed evidence faults separately from the trace verdict. They have no payout or reputation effect. |
| `prepareTraceClaim`, `prepareTraceChallenge`, `prepareMidpointOpening`, `prepareAdjudicationWitness` | **Current trace protocol, preparation only** | Build and validate calldata-shaped witnesses. They do not send transactions. |
| `claimResult`, `finalizeResult`, `disputeResult` | **Legacy settlement** | Optimistically accept a claimed outcome and allow a continuation-packet condition to determine local payout. A signed later packet does not prove execution, so this is not the settlement half of the trace protocol. |
| `claimTimeout`, `respondTimeout`, `forfeitTimeout` | **Legacy settlement** | Use weakly related caller-supplied hashes to drive a local timeout payout. They do not objectively identify who caused a stall. |
| `Outcome`, legacy result fields, `latestTranscriptHead`, and payout-related `PlayerStats` | **Legacy settlement data** | Support the older result/timeout path. They are not aliases for `StepVerdict` or current trace state. |
| `ARENA_ABI`, `outcomeFromWinner`, and the browser's `onchainChallenge`/`onchainJoin`/`onchainClaim`/`onchainFinalize` handlers | **Compatibility-only and disabled** | Preserve the shape of the old browser integration. `arena()` always throws and all four rendered transaction buttons are disabled. This is not the current trace client API. |
| `hh/test/settlement.cjs` | **Compatibility-only** | Records exact behavior and containment of the legacy contract surface. It does not certify that behavior as safe. |
| `hh/test/genesis.cjs`, `trace-dispute.cjs`, `step-adjudication.cjs`, and the evidence/trace Node tests | **Current trace protocol tests** | Verify authorization, fixed-root bisection, one-step execution, authority modes, and the no-settlement boundary. |
| Payout/refund/penalty from `StepVerdict`, unchallenged trace claims, trace non-response, or unavailable evidence | **Unresolved** | Requires the policy specifications in Issues #4 and #5 and later implementation, adversarial testing, and review. |

The contract enforces mutual exclusion between the legacy and trace claim paths:
a legacy result/timeout blocks a trace claim, and any trace claim blocks the
legacy result/timeout functions. Mutual exclusion prevents cross-path execution;
it does not make either legacy payout rule safe.

## Authoritative current trace path

The current path ends at a neutral fact:

1. `challenge` reserves a fresh match ID and records Player 1's partial offer.
2. `join` supplies Player 2 and replaces the provisional context with the hash
   of the complete `GenesisBinding`.
3. Both session keys approve that completed binding through `authorizeGenesis`.
4. Each browser independently reads the activated arena record before entering
   escrow mode. Practice mode has no arena or escrow authority.
5. Signed READY and input messages are saved before they are sent or used.
6. Reconstruction checks the complete supplied journal and creates one fixed
   authorized trace only if the evidence is complete and conflict-free.
7. The arena fixes claimant and challenger roots and bisects an unequal endpoint
   to one transition.
8. `GameTransitionVerifier` recalculates that transition, and the arena records
   `Claimant`, `Challenger`, or `Neither`.
9. The protocol stops. No current function maps that verdict to funds.

A practice archive cannot directly interact with the arena. Practice and escrow
READY messages use different signed contexts, and the evidence builder rejects
giving a practice archive an authoritative arena record. Individual input
packets stay compact and do not repeat chain, arena, or stake fields; therefore
a packet by itself never proves escrow authority. Consumers must require the
complete authorized evidence path, not a bare packet or caller-supplied label.

## `matchContextHash` lifecycle

`matchContextHash` is one storage field with two successive meanings. Code that
reads it must also know the challenge state and authorization state.

| Lifecycle point | Stored value | What may still change | Allowed reliance |
| --- | --- | --- | --- |
| After `challenge`, before `join` | **Provisional challenge context:** a hash of chain, arena, challenge, P1, stake, match ID, rules, P1 session, and response window. It is emitted in `ChallengeCreated`. | P2 main wallet and session are unknown; the completed binding and its hash do not exist. The optional opponent restriction is stored but is not part of this provisional hash. | Correlation and inspection only. It cannot be authorized: `genesisAuthorizationDigest` rejects an unjoined challenge, and trace context admission rejects it. |
| After `join`, before `authorizeGenesis` | **Completed binding hash:** `hashGenesisBinding(GenesisBinding)`. `join` writes the complete binding and overwrites the provisional value. | The binding fields and hash no longer change. Authorization may still fail or expire. | Session keys may sign the slot-specific authorization digest. Off-chain code may inspect the record, but it must not call it activated or use it as an authorized trace context. |
| After `authorizeGenesis` | **Authorized genesis context:** the same completed binding hash; authorization changes a separate boolean and does not rewrite the hash. | No binding field changes. Match status, claims, and dispute state may change around it. | Off-chain escrow mode and authorized trace construction require an independently read authorized record. On-chain `_traceContext` separately requires the arena's status to remain `Active` and `genesisAuthorized` to remain true. |
| After cancellation, unactivated refund, legacy finalization, or trace resolution | The stored bytes remain for history; they are not recycled. | The challenge status or trace phase has changed. | Historical inspection only unless the relevant current function's status gates still admit it. Stored bytes alone never prove current authority. |

Use these terms consistently:

- **provisional challenge context** for the pre-join value;
- **completed binding hash** for the immutable post-join value;
- **authorized genesis context** only when the completed value also has a valid,
  independently verified activation record.

Do not call the post-join hash a “finalized match.” `MatchStatus.Finalized` is a
legacy payout state and is unrelated to completion of the binding.

## Names that are easy to misread

These names remain because removing or renaming contract methods, stored fields,
browser handlers, and regression tests requires an explicit compatibility or
migration decision. Until then, interpret them by the status below rather than
by how current or authoritative the name sounds.

| Name | Meaning | It does not mean |
| --- | --- | --- |
| `matchId` / `genesis` | The same fresh bytes32 anchor, named from packet and binding viewpoints. | Contract authority by itself. |
| `GenesisBinding` | Complete match/escrow terms whose hash contextualizes compact moves. | An approved result or payout. |
| `genesisAuthorized` | Both delegated session keys approved the completed binding on the arena. | Settlement eligibility or proof every input executed. |
| `settlementEligible: false` | An explicit client-artifact safety marker. | A switch callers may change to gain authority. Verification rebuilds and checks it. |
| `claimResult` / `ResultClaimed` | Legacy optimistic result path. | A trace-root claim. |
| `claimTrace` / `TraceClaimed` | Current commitment to a trace root and endpoint. | A payout request or proof that the trace is correct. |
| `disputeResult` | Legacy continuation-packet payout challenge. | Current bisection or one-step adjudication. |
| claimant / challenger | Roles determined by who submitted the first and second trace roots. | Player 1/Player 2, winner/loser, or beneficiary/forfeiter. |
| `StepVerdict` | Which proposed post-checkpoint matches one canonical transition. | A match outcome, fraud judgment, penalty, or fund destination. |
| Merkle “proof” | Proof that a checkpoint is a member of a submitted root. | Proof that the checkpoint follows the game rules. |
| transcript `final` | The end of reconstructed gameplay. | `MatchStatus.Finalized` or settled funds. |
| “On-chain settlement” panel / “Final settlement payload” | Historical UI labels around disabled controls and diagnostic output. | An enabled settlement client. |

## Unresolved migration and policy decisions

This issue documents these questions; it does not answer them:

- whether a later contract version removes the legacy functions, keeps explicit
  reverting compatibility stubs, or migrates to a new arena;
- whether the shared challenge/join/authorization lifecycle remains in the same
  contract as future settlement;
- whether legacy fields, statistics, ABI exports, handlers, labels, and tests are
  deleted, renamed, or retained for historical compatibility;
- how unchallenged trace claims, missed trace responses, `Neither`, objective
  evidence faults, or unavailable evidence affect funds;
- what monitoring, archive delivery, RPC trust, confirmation, and reorganization
  rules are required; and
- how any later implementation migrates local test records. No production
  deployment or real-fund migration exists today.

[Issue #5](https://github.com/iThompkins/crypto-fighter/issues/5) owns evidence
availability and chain trust assumptions. [Issue #4](https://github.com/iThompkins/crypto-fighter/issues/4)
owns safe settlement and funded-state exit semantics. Neither issue should use
legacy payout behavior as an implicit default.
