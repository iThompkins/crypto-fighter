# Genesis authorization

## Scope

A fresh 256-bit `matchId` is the unique genesis anchor. The move digest is
unchanged: `H(abi.encode(genesis, frame, slot, mask, prevSelfHash, prevOppHash))`.
Moves do not repeat chain, contract, wallets, stake or other escrow fields.

The arena now registers the genesis once and requires both delegated session
keys to authorize its completed escrow binding. The immutable binding and its
signatures establish the authority behind that compact move identifier.
These signatures authorize the match before play, not its eventual result.
A terminal winner does not require a new opponent result signature.

This increment does not enable browser settlement or repair the legacy
continuation-packet dispute. It supplies the prerequisite authority and proof
primitives. The arena remains local-chain-only, and the pure Merkle verifier
cannot transfer funds or decide an outcome.

The [protocol-boundary guide](PROTOCOL_BOUNDARY.md) is authoritative for which
arena and client entry points are current, legacy, compatibility-only, disabled,
or unresolved.

## Contract lifecycle

1. `challenge` permanently reserves `challengeForGenesis[genesis]` for the new
   challenge. Zero/reused IDs are rejected. Cancellation does not free the ID.
2. `join` records a distinct P2 wallet and distinct nonzero session key, verifies
   equal stake/opponent restriction, and freezes a `GenesisBinding` snapshot.
   The original `Challenge.stake` may later become zero, but this snapshot never
   changes. `join` replaces the provisional `matchContextHash` with the completed
   binding hash. Before join, the provisional value cannot be authorized.
3. Each session signs its slot-specific authorization digest over the completed
   binding hash. `authorizeGenesis` can be relayed by anyone with both signatures;
   only the two delegated keys can produce the accepted signatures. Activation
   is atomic, one-time and requires a still-active challenge before or at the
   authorization deadline (`joinedAt + responseWindow`).
4. Legacy result and gameplay timeout entry points require activation. They
   remain unsafe settlement sketches, not the new trace dispute protocol.
5. If activation never completes, anyone may call `refundUnactivatedMatch` strictly
   after the deadline. It cancels once and returns each deposit to its owner,
   rather than declaring a gameplay loser. An activated match cannot use this
   refund. Effects precede guarded transfers; recipient contracts that refuse
   transfers remain a known push-payment recovery limitation.

Authorization changes `genesisAuthorized`; it does not rewrite the completed
binding hash. The exact provisional/completed/authorized states and permitted
consumers are listed in the [`matchContextHash` lifecycle](PROTOCOL_BOUNDARY.md#matchcontexthash-lifecycle).

Uniqueness is authoritative within the specified arena. Another arena/chain can
physically register the same bytes, but cannot reuse the original authorization:
its binding digest differs. Honest sessions must never authorize the same key/
genesis for multiple contexts. Fresh ephemeral sessions and the signer below
implement that policy; private keys must not be shared with alternative signers.
A nonce is not itself a proof of authority.

A public nonce can be preemptively reserved in the mempool. This cannot overwrite
an existing reservation or activate the victim's keys, but it can force a fresh
nonce/retry before match adoption. Clients must never silently adopt a conflicting
record after a failed creation. Reservation griefing and production availability
remain review items before funds are enabled.

## Exact binding and signature encoding

`GenesisBinding` is a static Solidity ABI tuple, in this order:

| Field | Type |
| --- | --- |
| chainId | uint256 |
| arena | address |
| challengeId | uint256 |
| genesis | bytes32 |
| rulesHash | bytes32 |
| p1, p2 | address, address |
| p1Session, p2Session | address, address |
| stake | uint256 |
| responseWindow | uint256 |
| restrictedOpponent | address |

There is one canonical rules fingerprint, not match-specific gameplay options.
Stake is the original per-player native-token deposit; the token/payment semantics
are fixed by this arena version. Escrow response deadlines do not change gameplay.

```
bindingTag = keccak256(UTF8("CryptoFighter.GenesisBinding.v1"))
bindingHash = keccak256(abi.encode(bindingTag, binding))
authorizationTag = keccak256(UTF8("CryptoFighter.GenesisAuthorization.v1"))
authorizationDigest = keccak256(abi.encode(authorizationTag, bindingHash, uint256 slot))
```

Signatures are raw-digest recoverable secp256k1 `r || s || v`, not personal-sign
strings. Slots are 1 or 2. Both browser and contract require low-S and v=27/28.
The chain/arena/challenge/participants/version/escrow domain is carried once in
this authorization, while moves inherit its binding through genesis.

## Off-chain authority and signing

`readGenesisRecord(provider, locator, optionalBlockNumber)` requires independently
selected chain ID, arena and challenge ID. It reads the binding and registry at
one block, verifies their domain/registration, and returns activation status.
A trusted RPC and the correct deployed arena are trust roots; this helper is
not a cryptographic light client and cannot make a malicious RPC trustworthy.
The optional block number permits reproducible reads, including test receipts.

`verifyGenesisAuthorization(authorization, record)` deliberately requires a
separate authoritative record. A self-declared authorization cannot serve as its
own evidence of registration. Numeric JSON fields use canonical decimal strings
to avoid unsafe number coercion.

`createGenesisSession(wallet, slot, expectedMainWallet)`:

- signs authorization only for the expected main-wallet slot and delegated key;
- locks that ephemeral session to one immutable binding before signing;
- refuses moves until both signatures and on-chain activation are verified;
- emits the unchanged compact move payload;
- refuses skipped/broken self chains and conflicting re-signatures for a frame.

Remote acknowledgement validation still belongs to the authenticated packet
pipeline. This signer does not infer network receipt from a caller-supplied hash.
The browser now integrates this authorization boundary with authenticated live
play and durable public evidence; see [Phase B](PHASE_B.md). Its escrow path requires
a local provider lookup and both authorization signatures before readiness.
No session private keys are persisted or recovered, and settlement remains disabled.

## Authorized trace commitments

`buildAuthorizedExecutionTrace(transcript, authorization, authoritativeRecord)`
verifies activation, both signatures, registered genesis, session identities and
a complete terminal transcript. It constructs `genesis-authorized-trace-v2`
using `bindingHash` as its Merkle context. The checkpoint/leaf structure is unchanged; Phase A uses v2 hash domains and integer state encoding. Authorized and diagnostic roots also differ because their context does.
An old diagnostic root cannot be promoted by relabeling metadata.

`verifyAuthorizedExecutionTraceCommitment` rebuilds the authorized root and checks
all authority, format and terminal metadata. `genesisAuthorized: true` establishes
that prerequisite only. `settlementEligible: false` remains explicit until the
complete settlement protocol exists. The experimental CLI continues to produce
diagnostic roots; the authorized API requires a chain record and has no implicit
self-authorizing file mode.

## Current dispute boundary

`src/bisection.ts` is an off-chain interactive coordinator. It authenticates the
registered binding, equal canonical genesis checkpoints and unequal terminal
endpoints under two fixed roots. Each round waits for both valid midpoint
openings. Wrong/replayed proofs cannot move its bracket. It isolates adjacent
indices within nine rounds and returns their checkpoint hashes, not a winner.

`contracts/TraceCommitmentVerifier.sol` verifies the same ordered nine-sibling
openings and checkpoint hashes in Solidity. It accepts only compact checkpoints
and branches, never the full transcript. It proves inclusion, not execution.
The integration test builds an authorized trace from an actually activated
Hardhat record and checks genesis/interior/terminal/padded-terminal openings in
Solidity, including wrong-domain/index/length rejection.

Claims, roots, midpoint turns/deadlines, and neutral isolated-step adjudication
are now implemented in the arena. Phase A supplies the numeric codec; Phases B
and C supply durable evidence and dispute artifacts; Phase D supplies the
one-step verifier. The current path records only `Claimant`, `Challenger`, or
`Neither`. It does not certify every other trace state or decide funds.
Availability, non-response, and result replacement/refund rules must be resolved
and tested before enabling payouts. Full-transcript on-chain replay is not an
allowed fallback.

## Historical continuation boundary — 2026-09-17

This dated milestone predates Phase A and Phase D. Arena trace claims and
authenticated midpoint turns/deadlines existed at that point; see
EXECUTION_TRACE.md. All legacy settlement entries reject matches with a trace
claim. The remaining single-step verifier is blocked on a reproduced state-codec
defect: valid canonical gameplay reaches quarter-unit coordinates, which the
current doubled-integer state encoding rejects. Genesis authorization remains
unchanged; it does not remedy this representation failure. No settlement is enabled.


## Historical Phase A numeric migration

The dated blocker above is resolved by [fixed-point protocol v2](FIXED_POINT_PROTOCOL.md).
Genesis binding and authorization v1 schemas are unchanged; their canonical rules
fingerprint now identifies v2. Old authorizations are not promoted to the new
protocol. No settlement or recovery entry point is added.
