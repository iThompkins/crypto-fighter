# Crypto Fighter

Crypto Fighter is a React/TypeScript experiment in deterministic two-player fighting-game simulation, signed input transcripts, and optimistic native-token escrow. Two browser peers exchange secp256k1-signed inputs over PeerJS and independently advance the same cumulative state.

> **Prototype warning:** the off-chain game and transcript verifier are an MVP, and CryptoFighterArena is an unaudited settlement sketch. The contract cannot prove the claimed terminal state, and its continuation dispute is unsound with delayed pre-signed inputs. Do not use it with real funds. Browser settlement transactions are disabled. The deployment script permits only the in-process Hardhat network, and the contract constructor rejects chain IDs other than 31337. These are development restrictions, not a proof of settlement safety; a chain ID alone does not establish that funds are valueless.

This document separates the implementation that exists from designs that do not. Claims are tied to [App.tsx](src/App.tsx), [game.ts](src/game.ts), [crypto.ts](src/crypto.ts), [types.ts](src/types.ts), [verifier.ts](src/verifier.ts), [verify-match.mjs](tools/verify-match.mjs), and [CryptoFighterArena.sol](contracts/CryptoFighterArena.sol).

## Fixed-point protocol v2

Phase A uses SCALE=256 integer geometry and nearest-midpoint rounding with ties
to even. Transcript v2 requires the canonical rules fingerprint; final-state and
trace hashes share one ABI codec. Development v1 replays are intentionally
unsupported. See [the numeric specification and behavioral comparison](docs/FIXED_POINT_PROTOCOL.md).
Existing trace formats/codecs are migrated, but one-step adjudication and trace
payout/recovery remain unimplemented. Settlement stays disabled.

## Player flow

1. Page load creates an ephemeral secp256k1 session wallet in browser memory, separate from any injected main wallet.
2. One player initializes **Host Tab** (P1). The other initializes **Joiner Tab** (P2), pastes the host Peer ID, and connects through PeerJS.
3. Each connection exchanges fresh challenges and signed HELLO responses. Runtime schema, signature, challenge, slot, and pinned session identity are checked before discovery is admitted.
4. The host offers an immutable practice or locally verified escrow descriptor. Both peers persist signed readiness, then persist authenticated inputs before sending, acknowledging, or simulating them. Only recursively valid input pairs advance play.
5. Simulation stops when HP reaches zero or the 300-frame timer expires. Either peer can export and replay the packet/canonical-frame transcript.
6. The settlement panel connects a main wallet and exposes challenge, join, claimResult, and finalizeResult. All four transaction actions are disabled pending a complete security model. It does not expose dispute, timeout, or cancellation calls.

**Controls (symmetric):** A/D or left/right arrows move, W or up-arrow jumps, and Space, F, J, K, or / attacks. Each peer controls only its assigned fighter.

**New Match** closes the local session and connection, preserves its evidence journal, and generates a fresh session wallet and match ID. Reconnect the peers for the new match. Remote reset messages are rejected. Reload recovers inspection evidence, never the old signing key.

## Canonical protocol and match genesis

There is one canonical ruleset at a time. Damage, timer, movement, physics and
other gameplay behavior are compiled constants, not match settings.
[src/protocol.ts](src/protocol.ts) identifies that version with a fixed fingerprint.
The legacy transcript `rules` object is descriptive metadata; altered values
fail verification. The escrow accepts only the canonical fingerprint.

Each live match starts with a fresh cryptographically random 256-bit `matchId`,
a UUID-like genesis nonce. Every move digest includes that ID, so identical
moves in different matches have distinct chains. Initial zero hashes are only
previous-link sentinels. The fixed ID in the transcript generator is test-only.

The arena now permanently registers that genesis and requires both delegated
session keys to authorize the completed immutable escrow binding once. Later
move signatures rely on that binding without repeating its fields. See
[genesis authorization](docs/GENESIS_AUTHORIZATION.md) for the protocol and tested
limits. The browser supports practice and explicitly loaded, independently verified
escrow-authorized matches. Funding and production settlement remain disabled.
See [Phase B lifecycle and persistence](docs/PHASE_B.md) for admission and recovery guarantees.

## Deterministic cumulative GameState

[game.ts](src/game.ts) defines the pure transition(previousState, p1Mask, p2Mask) function. Each canonical frame applies one transition to the preceding state; state is cumulative.

~~~ts
type GameState = {
  frame: number;
  timerFramesLeft: number;
  p1: Fighter;
  p2: Fighter;
  winner: "P1" | "P2" | "TIE_BOTH_LOSE" | null;
  roundOver: boolean;
};

type Fighter = {
  x: number; y: number; hp: number; // x/y/vy are integer simulation units
  facing: 1 | -1;
  attackCooldown: number;
  attackActive: number;
  vy: number;
};
~~~

Displayed gameplay constants are a 720×360 stage, floor Y=260, 30 target FPS, 300 frames/10 seconds, 28×56 fighters, 5 units/frame movement, jump velocity 22, gravity 2, 7 maximum HP, and 1 damage per overlapping active-attack frame.

Transition order is:

1. Increment frame and decrement timerFramesLeft, clamped at zero.
2. Decrement attack cooldown/active counters.
3. Apply horizontal input and stage bounds. Left+right cancel.
4. Start a grounded jump, apply integer gravity/velocity, and clamp to ground.
5. Resolve body overlap only while vertical ranges overlap, allowing jumps over an opponent.
6. Update facing from the last non-zero horizontal movement.
7. Start an attack only when both attack counters are zero. It is active for four transitions and has a ten-frame cooldown.
8. Test each active attack rectangle against the other body. Damage applies on **every** overlapping active frame, so one activation can remove multiple HP. Simultaneous hits apply before winner selection.
9. Zero HP ends first: both zero means TIE_BOTH_LOSE; otherwise the survivor wins. If neither is zero when time reaches zero, higher HP wins and equal HP means TIE_BOTH_LOSE.

### Exactly what React draws

[App.tsx](src/App.tsx) uses React DOM elements, not canvas:

- a scaled floor line on a fixed-coordinate arena;
- one rectangular body per fighter using cumulative x/y and compiled dimensions, converted from simulation units;
- an attack rectangle while getAttackRect returns one;
- HP bars/numbers, timerFramesLeft / 30, frame, outcome, sync status, and session identities;
- an end banner after roundOver; and
- in developer mode, packet/frame logs, transcript controls, hashes, and timing data.

CSS scaling does not enter simulation or hashing. A loaded replay draws its selected replay state through the same elements; otherwise they draw live state. React does not interpolate, predict, or calculate damage separately.

## Input and transcript shapes

### Input masks

| Bit | Value | Meaning |
| --- | ---: | --- |
| 0 | 1 | left |
| 1 | 2 | right |
| 2 | 4 | attack |
| 3 | 8 | up/jump |

The unchanged input-mask v1 protocol permits exactly the unsigned integer values 0 through 15. Every combination of the four known bits is valid, including left+right; higher bits are invalid rather than ignored. Browser/runtime code applies `typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0x0f` without coercing, rounding, truncating, clamping, or masking a value into range.

JSON validation is over parsed JavaScript binary64 values. A source number is therefore accepted when its parsed value is a safe integer in 0..15, regardless of spelling or pre-conversion rounding/underflow; for example, `1e-400` parses as zero and is accepted, while `1e400` parses as infinity and is rejected. Lexical JSON canonicalization is outside the input-mask protocol.

### SignedInputPacket

~~~ts
type SignedInputPacket = {
  matchId: string; frame: number; player: 1 | 2; inputMask: number;
  prevSelfHash: string; prevOppHash: string;
  publicKey: string; signature: string; hash: string;
};
~~~

Packet hash and signed digest are the same value:

~~~text
keccak256(abi.encode(
  bytes32 matchId, uint256 frame, uint256 player, uint256 inputMask,
  bytes32 prevSelfHash, bytes32 prevOppHash
))
~~~

The signature is recoverable secp256k1 r||s||v over that raw digest. publicKey, signature, and hash are not fields in the digest. HELLO key pinning and transcript player identities bind the recovered signer to a slot.

Packet chains start at bytes32 zero. With delay 2, packet F self-links to that player's F-1 packet and acknowledges the opponent's F-2 packet; frames 1 and 2 acknowledge zero.

### CanonicalFrame

~~~ts
type CanonicalFrame = {
  matchId: string; frame: number;
  p1InputMask: number; p2InputMask: number;
  prevFrameHash: string; frameHash: string;
};
~~~

~~~text
frameHash = keccak256(abi.encode(
  bytes32 matchId, uint256 frame, uint256 p1InputMask,
  uint256 p2InputMask, bytes32 prevFrameHash
))
~~~

The frame chain starts at bytes32 zero and commits ordered paired inputs, not GameState.

### MatchTranscript version 2

~~~ts
type MatchTranscript = {
  version: 2;
  rulesHash: string;
  matchId: string;
  rules: {
    fps: number; roundFrames: number; maxHp: number;
    oneOutstandingPacket: true; // legacy field
    inputDelay: number;
  };
  players: {
    p1: { slot: 1; address: string; publicKey: string };
    p2: { slot: 2; address: string; publicKey: string };
  };
  packets: SignedInputPacket[];
  canonicalFrames: CanonicalFrame[];
  final: {
    frame: number; frameHash: string; stateHash: string;
    p1Hp: number; p2Hp: number;
    winner: "P1" | "P2" | "TIE_BOTH_LOSE" | null;
    roundOver: boolean;
  };
};
~~~

stateHash is Keccak-256 of the canonical v2 ABI state encoding, also used by traces. oneOutstandingPacket remains descriptive legacy metadata even though netcode uses inputDelay 2; it is not a precise buffering-window statement.

## Lockstep and input delay

~~~text
simulation at N
  -> sign unsent local packets through N + 2
  -> packet F waits until opponent packet F - 2 is known
  -> with both packets for N + 1, hash and apply exactly N + 1
  -> otherwise remain at cumulative state N
~~~

The first tick can sign frames 1 and 2. Later signing maintains a two-frame horizon. The 30 Hz timer advances at most one canonical frame per tick; packet arrival only buffers. Missing acknowledgement stalls signing, and a missing next pair stalls simulation, so wall-clock rounds may exceed ten seconds.

The receiver tolerates packets through currentFrame + INPUT_DELAY + 2 (currently four frames ahead); the sender normally produces only through currentFrame + INPUT_DELAY (two ahead). Sequential self-chain checking assumes PeerJS ordered delivery.

Delay creates a protocol gap: a valid future packet may have been signed before an earlier canonical frame ended the round. It does not prove execution. Withholding can also reveal up to the delay horizon of remote signed moves; commit-reveal is not implemented.

## Validation boundaries

### Realtime

[App.tsx](src/App.tsx) first rejects a remote packet whose input mask is not a valid v1 value, before hashing or buffering it. It then checks remote slot, match ID, stale/future window, public-key continuity after HELLO, recomputed hash, sequential self-chain, F-2 acknowledgement, conflicting buffered frame/slot packets, and signature recovery. Local packets are produced from the four canonical bits and are not run through this remote validator. Only the next complete pair advances.

### Transcript replay

[verify-match.mjs](tools/verify-match.mjs) now loads the exact browser
[verifier.ts](src/verifier.ts) and game transition through the Node 20 TypeScript
loader. There is no separate CLI rules implementation. The CLI therefore needs
the repository source and installed TypeScript dependency.

Strict verification requires bounded arrays, contiguous canonical frames from
frame 1, a complete final record including its state hash, the v2 fingerprint and exact declared
rules, valid distinct curve-point identities, and authenticated packets for every
executed frame. Every supplied delayed packet is also checked for signature,
identity, self chain and F-2 acknowledgement. Tail packets are bounded to the
input-delay horizon and never extend the replay or its terminal packet heads.
Canonical frames after the first terminal state are rejected. Missing/gapped,
duplicate, truncated, malformed and nonterminal terminal claims fail closed.

All packet and canonical input masks are checked before hashing/signature work.
Unknown bits remain invalid. Packet/frame digest encoding is unchanged.

For diagnostic replay only, explicitly opt into partial mode:

~~~bash
npm run verify-match -- path/to/prefix.json --allow-partial
~~~

The browser offers the same opt-in checkbox. An internally valid nonterminal
prefix can then return `ok: true`, but always `complete: false`. Default strict
verification requires a terminal history. Every bare transcript result, including complete
terminal replay, reports `settlementEligible: false`: a bare transcript does not establish authoritative genesis activation, and the contract does not verify execution.
This change does not authorize payouts or claim on-chain meaning for stateHash.

## Main wallets and session keys

- **Main wallet:** injected EVM wallet and msg.sender for escrow. Its challenge/join transaction commits its session address and transfers native stake.
- **Session key:** ephemeral browser-generated key for per-frame signatures. It pays no gas. Solidity can recover it from disclosed packets.

onlyParticipant means exactly msg.sender == stored p1 or p2 **main-wallet** address; it does not authorize session keys. It protects claimResult, disputeResult, claimTimeout, and respondTimeout. finalizeResult and forfeitTimeout are permissionless when ready. cancelOpenChallenge separately requires P1. challenge and eligible join calls are public.

## Current native-token escrow

Only the chain's native token is accepted through payable calls. **ERC-20 and stablecoin support is not implemented.** There is no token address, allowance, transferFrom, oracle, or stable-value mechanism.

### Challenge and join

challenge requires non-zero native stake, matchId, P1 session address, the sole canonical rulesHash, and at least a 24-hour response window. rulesHash identifies the canonical game version; it does not configure gameplay. It stores an open challenge and context hash over chain ID, contract, challenge ID, P1 main wallet, stake, match ID, rules hash, P1 session key, and window. Optional expectedOpponent is stored/emitted but omitted from the initial context-hash calculation.

join requires Open status, a caller other than P1, exactly equal stake, and a non-zero P2 session address. If expectedOpponent is non-zero, only that main wallet can join; zero makes it open. Join stores P2/session key (requiring distinct keys), makes the escrow Active but
not yet authorized for play, and freezes the full GenesisBinding. Its hash replaces
the provisional matchContextHash. Both session authorizations must activate the
genesis before result or timeout actions. Unactivated matches refund both deposits
after the authorization deadline; their genesis reservations remain permanent.

### Claim, dispute, and finalize

claimResult requires an Active, genesis-authorized match, participant caller, no existing result claim, no active timeout, outcome P1/P2/Tie, and non-zero finalHead. It otherwise stores claimant-supplied outcome, final frame, frame head, and packet heads and starts the deadline.

disputeResult is limited to the other participant while block.timestamp <= the deadline. It requires two packets at claimedFinalFrame + 1, slots 1/2, stored match ID, v1 input masks with no bits above `0x0f`, prevSelfHash links to claimed packet heads, and signatures recovering to stored session keys. It does **not** check prevOppHash, canonical-frame chain, state, terminality, or claimed outcome. Success awards the pot to the disputer and records counters.

That continuation condition does **not** prove execution and is unsound with delayed inputs because signed packets may never have executed.

finalizeResult is permissionless only while block.timestamp > the deadline and pays the trusted outcome: P1/P2 gets the two-stake pot; Tie splits it with P1 getting integer half and P2 any one-wei remainder. The deadline is inclusive for disputes: at the exact timestamp dispute remains available and finalization reverts; finalization begins one timestamp tick later. Stake is zeroed before transfers and settlement paths use a simple reentrancy guard.

### Timeout and cancellation

claimTimeout lets either participant accuse the other while Active, genesis-authorized, and no timeout is active. It requires frame > 0 and non-zero transcriptHead/packetHash, stores them, and starts a deadline.

respondTimeout requires the accused before deadline, a non-regressing frame, and non-zero replacement hashes, then clears the timeout. **No signatures or relationship among these hashes are verified.** After deadline anyone may call forfeitTimeout, awarding the pot to the timeout claimant. This is scaffolding, and the UI exposes none of it.

Before join only P1 may cancelOpenChallenge; it marks Cancelled and refunds the stake. Active matches cannot use this cancellation path.

### Enforced on-chain versus trusted

| Item | Treatment |
| --- | --- |
| Native stake/equal join stake | Enforced |
| Main-wallet participants/optional P2 restriction | Enforced |
| Non-zero identifiers/session keys and 24h minimum | Enforced |
| Session delegation | Inferred from a main wallet committing its own session address |
| Disclosed next packets: digest/signers/frame/slots/match/masks/self links | Enforced only in disputeResult |
| rulesHash | Must equal the sole canonical version fingerprint |
| Outcome, final frame, frame head, packet heads | Claimant supplied; minimal checks only |
| Canonical chain/full transcript | Not checked |
| Transition, HP, timer, terminality, winner | Not implemented on-chain |
| Timeout hashes | Non-zero only; relationship/signatures trusted |
| Genesis-to-escrow authority | Both session keys sign the frozen binding once; moves retain genesis-only context |

## Merkle trace and interactive bisection direction

The intended settlement architecture uses **optimistic Merkle-committed execution,
interactive bisection, and minimal on-chain transition verification**. Solidity
must not receive or replay the complete match transcript. An undisputed claim
can finalize after its challenge window; a dispute must authenticate midpoint
openings until it isolates a transition to check.

The prior README proposal is preserved and developed in
[docs/EXECUTION_TRACE.md](docs/EXECUTION_TRACE.md), including the inspection findings,
encoding, dispute invariants, availability requirements, and remaining work.

Implemented now: experimental off-chain trace construction from a strictly
verified terminal transcript, canonical ABI integer-state encoding, ordered Merkle trees,
and bounded checkpoint membership proofs. Phase A fixed-point migration resolves
the former quarter-unit encoding blocker. One-step adjudication is still pending.
[Phase B status and policy boundaries](docs/PHASE_B.md) document the authenticated
live authentication, durable evidence, and reload/reconnect behavior.
Authenticated but unexecuted delayed inputs cannot alter the root. Browser and CLI use the same implementation.

~~~bash
npm run make-transcript -- /tmp/terminal.json
node tools/commit-trace.mjs /tmp/terminal.json 90 > /tmp/commitment.json
npm run verify-trace -- /tmp/terminal.json /tmp/commitment.json
~~~

The output includes the root, experimental off-chain context, complete numeric
rules/genesis hash with semantic revision, terminal metadata, and a nine-sibling
opening for the selected checkpoint. These are **not escrow-authorized roots**:
the diagnostic CLI does not establish authoritative genesis activation and every output is marked
`settlementEligible: false`.

Now implemented in addition: immutable escrow-bound genesis authorization,
authorized trace roots, an off-chain authenticated bisection coordinator, and
compact Solidity Merkle membership verification. On-chain root claims and interactive bisection turns/deadlines are also implemented
(see the execution-trace document). One-step adjudication, authenticated timeout
resolution and availability recovery remain pending. Trace claims block all legacy
settlement paths and currently have no payout/recovery entry point. The existing continuation-packet dispute conflicts with this design and
must eventually be replaced. No full-transcript on-chain replay fallback is planned.

## Safety limitations

- Experimental, unaudited contract; no real-fund safety claim.
- Wrong outcome at the true final frame cannot be disproved by continuation.
- Pre-signed delayed inputs can falsely satisfy continuation after round end.
- Unauthenticated timeout hashes can produce unjustified forfeits.
- The canonical rules fingerprint is enforced, but outcome/trace claim fields remain trusted; Solidity has no game verifier.
- Moves intentionally sign only genesis context; authorized use requires the one-time
  registered binding. The practice UI does not yet integrate this lifecycle.
- Solidity and browser signature recovery enforce low-S and v=27/28.
- PeerJS/browser memory are not hardened custody, privacy, availability, or DoS systems; reset/reload loses keys.
- Input delay permits limited lookahead; commit-reveal is only proposed.
- Session delegation now requires distinct session addresses.
- Reputation counters are event counts, not proof of honesty or skill.
- UI covers only part of lifecycle and does not monitor deadlines.
- ERC-20/stablecoins, fees, upgrades, emergency recovery, and production operations are absent.

## Staged roadmap

1. **Freeze off-chain specification:** versioned encoding/schema, canonical-version agreement, mask bounds, golden vectors, and browser/CLI parity tests.
2. **Authenticate execution:** co-signed canonical receipts or commit-reveal plus execution acknowledgements; remove delay ambiguity.
3. **Build proof primitives:** canonical state, trace leaves, Merkle proofs, bisection, one-step verifier, and availability rules.
4. **Replace timeout scaffolding:** authenticated relationships and adversarial deadline/stall/non-response tests.
5. **Harden escrow:** threat model, fuzz/invariant testing, audit, domain/signature hardening, complete UI, monitoring/recovery.
6. **Only then consider other assets:** ERC-20/stablecoins require explicit accounting, safe transfers, denomination policy, and separate review.

## White-paper outline

1. Scope, non-goals, and trust boundaries.
2. Peer, transport, main-wallet, session-key, and EVM system model.
3. Deterministic state, constants, inputs, transition order, and terminal rules.
4. Packet digest, acknowledgement/self chains, canonical frames, identity binding.
5. Handshake/reset, input delay, lockstep, ordering, and stalls.
6. Off-chain replay algorithm, invariants, evidence, and gaps.
7. Current escrow state machine, access control, timing, and payouts.
8. Threats: withholding, lookahead, replay, claims, key loss, transport failure.
9. Proposed canonical state, Merkle trace, bisection, and one-step proof.
10. Economic/timing assumptions, gas, griefing, and slashing.
11. Test vectors, differential/fuzz/invariant tests, audits, staged value limits.
12. Open questions: acknowledgement, simultaneous disputes, assets, governance/upgrades.

## Requirements

- Node.js 20.19+
- npm

## Run locally

~~~bash
npm install
npm run dev
~~~

Open the Vite URL in two tabs.

1. In tab one, click **Host Tab**.
2. In tab two, click **Joiner Tab**.
3. Copy the host Peer ID into the joiner tab.
4. Click **Connect** in the joiner tab.
5. Click **Start Match**.

For reproducible validation after `npm ci`:

~~~bash
npx playwright install chromium  # one-time browser setup
npm run check                   # lint, Node tests, build, contract and browser tests
~~~

On a machine with system Chromium (including this ARM64 workspace), use:

~~~bash
CHROMIUM_PATH=/usr/bin/chromium npm run check
~~~

The browser suite starts and stops its own Vite and PeerJS servers on loopback
ports 4175 and 9001, with external STUN disabled. Those ports must be free. It
checks a generated terminal replay against the CLI and runs two actual WebRTC
peers through a 300-frame idle round, comparing exported canonical histories and
final state. It also tests disconnect/reconnect, IndexedDB recovery, inspection-only
reload, and escrow authentication through a fixture wallet/RPC. Settlement remains
disabled. No external wallet, signaling service, RPC, or real funds are used. Failure traces
and exported transcripts are retained in ignored `test-results/`.

`npm run test:browser` runs only that suite. The older `check-app.cjs`,
`connect-two-tabs.cjs`, and `self-play.cjs` commands forward to its relevant tests.
`capture-app.cjs` remains a screenshot utility requiring a running preview server.

## Scripts

~~~bash
npm run dev           # start Vite dev server
npm run build         # typecheck and build production assets
npm run lint          # run ESLint
npm run preview       # preview production build
npm run verify-match  # verify/replay an exported transcript JSON
~~~

## Transcript replay

The **Transcript replay** panel accepts pasted JSON or a .json file. **Verify + Load** runs the browser verifier and enables scrubbing/playback.

~~~bash
npm run verify-match -- path/to/transcript.json
~~~

## Local on-chain testing

The Hardhat harness is isolated in hh/:

~~~bash
npm run test:contract        # deploy to a local EVM; assert happy path + dispute
~~~

The harness uses lockfile-pinned `solc` 0.8.26 without compiler downloads and
stores its configuration/cache in `.cache/hardhat/`. Tests create only valueless,
in-process EVM contracts, including a negative test with simulated chain ID 1.
Browser settlement and the old `hh/e2e-onchain.cjs` workflow are disabled.

`simulate-arena` now exits with a retirement notice: its former JavaScript model
used a different protocol and must not be treated as contract validation. Use
`npm run test:contract` for the actual Solidity behavior.

## Source layout

~~~text
contracts/CryptoFighterArena.sol  native escrow/result/timeout prototype
hh/test/settlement.cjs            local contract tests
test/browser/gameplay.spec.mjs   local browser gameplay/replay checks
tools/verify-match.mjs            CLI adapter for shared transcript verifier
src/App.tsx                       UI, PeerJS, realtime validation
src/chain.ts                     injected wallet and minimal Arena ABI
src/crypto.ts                    keys, signatures, and hashes
src/game.ts                      deterministic transition
src/types.ts                     shared protocol types
src/verifier.ts                  browser verifier/replayer
~~~


## Verified takeover audit (2026-09-16)

See [AUDIT.md](AUDIT.md) for the code-verified baseline, checks, and ordered blockers.
Run `npm test` on Node 20.19+ for input-mask parity and browser settlement containment;
the test-only loader uses the installed TypeScript compiler. `npm run build` still
performs full TypeScript checking. `npm run test:contract` includes a negative
constructor test on a simulated chain ID 1, entirely inside Hardhat with no external RPC.
No deployment command is part of the verification workflow.
