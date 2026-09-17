# Crypto Fighter

Crypto Fighter is a React/TypeScript experiment in deterministic two-player fighting-game simulation, signed input transcripts, and optimistic native-token escrow. Two browser peers exchange secp256k1-signed inputs over PeerJS and independently advance the same cumulative state.

> **Prototype warning:** the off-chain game and transcript verifier are an MVP, and CryptoFighterArena is an unaudited settlement sketch. The contract cannot prove the claimed terminal state, and its continuation dispute is unsound with delayed pre-signed inputs. Do not use it with real funds. Browser settlement transactions are disabled. The deployment script permits only the in-process Hardhat network, and the contract constructor rejects chain IDs other than 31337. These are development restrictions, not a proof of settlement safety; a chain ID alone does not establish that funds are valueless.

This document separates the implementation that exists from designs that do not. Claims are tied to [App.tsx](src/App.tsx), [game.ts](src/game.ts), [crypto.ts](src/crypto.ts), [types.ts](src/types.ts), [verifier.ts](src/verifier.ts), [verify-match.mjs](tools/verify-match.mjs), and [CryptoFighterArena.sol](contracts/CryptoFighterArena.sol).

## Player flow

1. Page load creates an ephemeral secp256k1 session wallet in browser memory, separate from any injected main wallet.
2. One player initializes **Host Tab** (P1). The other initializes **Joiner Tab** (P2), pastes the host Peer ID, and connects through PeerJS.
3. HELLO carries the host-selected matchId, player slot, session address, and uncompressed public key. The receiver checks the expected remote slot and derives the address from the key. The joiner adopts the host match context.
4. The host starts the match. Each peer samples its own keyboard, signs inputs ahead of simulation, validates remote packets, and advances only when the next P1/P2 pair exists.
5. Simulation stops when HP reaches zero or the 300-frame timer expires. Either peer can export and replay the packet/canonical-frame transcript.
6. The settlement panel connects a main wallet and exposes challenge, join, claimResult, and finalizeResult. All four transaction actions are disabled pending a complete security model. It does not expose dispute, timeout, or cancellation calls.

**Controls (symmetric):** A/D or left/right arrows move, W or up-arrow jumps, and Space, F, J, K, or / attacks. Each peer controls only its assigned fighter.

**New Match** generates a fresh session wallet and match ID, resets state/transcript, sends an identity-bearing RESET_MATCH, and repeats HELLO. Session keys are not durable account keys.

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
  x: number; y: number; w: number; h: number; hp: number;
  facing: 1 | -1;
  attackCooldown: number;
  attackActive: number;
  vy: number;
};
~~~

Current constants are a 720×360 stage, floor Y=260, 30 target FPS, 300 frames/10 seconds, 28×56 fighters, 5 units/frame movement, jump velocity 22, gravity 2, 7 maximum HP, and 1 damage per overlapping active-attack frame.

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
- one rectangular body per fighter using cumulative x, y, w, and h;
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

Transcript v1 permits exactly the unsigned integer values 0 through 15. Every combination of the four known bits is valid, including left+right; higher bits are invalid rather than ignored. Browser/runtime code applies `typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0x0f` without coercing, rounding, truncating, clamping, or masking a value into range.

JSON validation is over parsed JavaScript binary64 values. A source number is therefore accepted when its parsed value is a safe integer in 0..15, regardless of spelling or pre-conversion rounding/underflow; for example, `1e-400` parses as zero and is accepted, while `1e400` parses as infinity and is rejected. Lexical JSON canonicalization is outside v1.

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

### MatchTranscript version 1

~~~ts
type MatchTranscript = {
  version: 1;
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

stateHash is keccak256 of UTF-8 JSON.stringify(finalGameState) and is off-chain only. oneOutstandingPacket remains true in version 1 even though netcode uses inputDelay 2; the legacy field is not a precise buffering-window statement.

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
frame 1, a complete final record including its state hash, exact declared v1
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
verification requires a terminal history. Every v1 result, including complete
terminal replay, reports `settlementEligible: false`: signatures still do not bind
rules/version and escrow context, and the contract does not verify execution.
This change does not authorize payouts or claim on-chain meaning for stateHash.

## Main wallets and session keys

- **Main wallet:** injected EVM wallet and msg.sender for escrow. Its challenge/join transaction commits its session address and transfers native stake.
- **Session key:** ephemeral browser-generated key for per-frame signatures. It pays no gas. Solidity can recover it from disclosed packets.

onlyParticipant means exactly msg.sender == stored p1 or p2 **main-wallet** address; it does not authorize session keys. It protects claimResult, disputeResult, claimTimeout, and respondTimeout. finalizeResult and forfeitTimeout are permissionless when ready. cancelOpenChallenge separately requires P1. challenge and eligible join calls are public.

## Current native-token escrow

Only the chain's native token is accepted through payable calls. **ERC-20 and stablecoin support is not implemented.** There is no token address, allowance, transferFrom, oracle, or stable-value mechanism.

### Challenge and join

challenge requires non-zero native stake, matchId, rulesHash, P1 session address, and at least a 24-hour response window. It stores an open challenge and context hash over chain ID, contract, challenge ID, P1 main wallet, stake, match ID, rules hash, P1 session key, and window. Optional expectedOpponent is stored/emitted but omitted from the initial context-hash calculation.

join requires Open status, a caller other than P1, exactly equal stake, and a non-zero P2 session address. If expectedOpponent is non-zero, only that main wallet can join; zero makes it open. Join stores P2/session key, makes the match Active, and extends matchContextHash with P2 main/session addresses.

### Claim, dispute, and finalize

claimResult requires an Active match, participant caller, no existing result claim, no active timeout, outcome P1/P2/Tie, and non-zero finalHead. It otherwise stores claimant-supplied outcome, final frame, frame head, and packet heads and starts the deadline.

disputeResult is limited to the other participant while block.timestamp <= the deadline. It requires two packets at claimedFinalFrame + 1, slots 1/2, stored match ID, v1 input masks with no bits above `0x0f`, prevSelfHash links to claimed packet heads, and signatures recovering to stored session keys. It does **not** check prevOppHash, canonical-frame chain, state, terminality, or claimed outcome. Success awards the pot to the disputer and records counters.

That continuation condition does **not** prove execution and is unsound with delayed inputs because signed packets may never have executed.

finalizeResult is permissionless only while block.timestamp > the deadline and pays the trusted outcome: P1/P2 gets the two-stake pot; Tie splits it with P1 getting integer half and P2 any one-wei remainder. The deadline is inclusive for disputes: at the exact timestamp dispute remains available and finalization reverts; finalization begins one timestamp tick later. Stake is zeroed before transfers and settlement paths use a simple reentrancy guard.

### Timeout and cancellation

claimTimeout lets either participant accuse the other while Active and no timeout is active. It requires frame > 0 and non-zero transcriptHead/packetHash, stores them, and starts a deadline.

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
| rulesHash contents | Opaque non-zero value; trusted |
| Outcome, final frame, frame head, packet heads | Claimant supplied; minimal checks only |
| Canonical chain/full transcript | Not checked |
| Transition, HP, timer, terminality, winner | Not implemented on-chain |
| Timeout hashes | Non-zero only; relationship/signatures trusted |
| matchContextHash in packet signatures | Not implemented; packets sign matchId only |

## Merkle/bisection proposal — nowhere implemented

**Merkle state roots, interactive bisection, and one-step fraud proofs are design only and are nowhere implemented in React, verifier, tools, or Solidity.** Current frameHash is a linear input hash chain and stateHash is one off-chain JSON hash; neither is a Merkle root.

A proposed architecture could:

1. Specify canonical cross-language encodings for rules and every state.
2. Commit each transition leaf to frame, pre-state hash, two authenticated packet hashes, frame hash, and post-state hash.
3. Merklize ordered leaves; claims submit trace root/length/terminal state/outcome, with a new mechanism acknowledging actual execution because packet signatures alone are insufficient.
4. For incompatible claims, run deadline-bound on-chain binary search over authenticated midpoints to isolate the first disagreement.
5. Supply pre-state, inputs, execution evidence, claimed post-state, and Merkle branches for one disputed step.
6. Execute one specified transition in Solidity or a verification VM and reject/slash the inconsistent claim.
7. Specify data availability, abandonment, non-response, and maximum traces so branch withholding cannot win.

This requires new formats, serialization, contract state machines, transition verification, tests, and audits. It must not be described as current capability.

## Safety limitations

- Experimental, unaudited contract; no real-fund safety claim.
- Wrong outcome at the true final frame cannot be disproved by continuation.
- Pre-signed delayed inputs can falsely satisfy continuation after round end.
- Unauthenticated timeout hashes can produce unjustified forfeits.
- Rules and claim fields are largely trusted; Solidity has no game verifier.
- Packet signatures omit chain, contract, challenge, matchContextHash, and rulesHash domain; reused match IDs create ambiguity.
- Solidity does not explicitly enforce low-S or validate v before ecrecover.
- PeerJS/browser memory are not hardened custody, privacy, availability, or DoS systems; reset/reload loses keys.
- Input delay permits limited lookahead; commit-reveal is only proposed.
- Both players may delegate the same session address.
- Reputation counters are event counts, not proof of honesty or skill.
- UI covers only part of lifecycle and does not monitor deadlines.
- ERC-20/stablecoins, fees, upgrades, emergency recovery, and production operations are absent.

## Staged roadmap

1. **Freeze off-chain specification:** versioned encoding/schema, rule negotiation, mask bounds, golden vectors, and browser/CLI parity tests.
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

- Node.js 24+
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
final state. It also asserts that browser settlement remains disabled. No wallet,
external signaling service, external RPC, or real funds are used. Failure traces
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
