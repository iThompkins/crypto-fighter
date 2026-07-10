# Crypto Fighter

A React + TypeScript + Vite MVP for a tiny peer-to-peer fighting game with signed frame inputs, strict off-chain realtime verification, transcript export, and an early escrow/dispute contract sketch.

Two browser tabs connect through PeerJS. Each tab generates an ephemeral secp256k1 session wallet, signs one local input packet for the next frame, verifies the remote player's packet, and only advances deterministic game state when both valid packets for the next canonical frame are present. Session-key signatures are recoverable on any EVM chain via `ecrecover`, so the same history the game replays off-chain is also settlement-grade on-chain.

## Current model

The game uses strict lockstep for the provably-fair MVP:

```text
canonical frame N
  -> each player may sign exactly one packet for N+1
  -> game waits until P1 and P2 packets for N+1 are valid
  -> canonicalize frame N+1
  -> repeat
```

This intentionally avoids deep future buffering. If one player stops sending packets, the other player does **not** continue revealing future inputs. The screen can pause/stall, but the honest player leaks at most one outstanding committed input.

## Packet chain

Each signed input packet includes:

```ts
type SignedInputPacket = {
  matchId: string;
  frame: number;
  player: 1 | 2;
  inputMask: number;
  prevSelfHash: string;
  prevOppHash: string;
  publicKey: string;
  signature: string;
  hash: string;
};
```

The key fields are:

- `prevSelfHash`: links this player’s packet to their own previous canonical packet.
- `prevOppHash`: proves the latest opponent packet this player had acknowledged when signing.

Together they form a cryptographically verifiable packet transcript. Game state itself is not signed directly; it is deterministically replayed from signed packets.

## Features

- Two-player PeerJS connection: one host tab, one joiner tab.
- Deterministic 30 FPS target simulation.
- Strict one-outstanding-frame packet window.
- Signed per-frame input packets using secp256k1 over a keccak256 `abi.encode` digest (EVM-recoverable via `ecrecover`).
- Realtime packet validation:
  - match context
  - expected player slot
  - one-frame window
  - public-key continuity
  - canonical packet hash
  - self hash chain
  - opponent acknowledgement hash
  - duplicate/conflicting packet detection
  - signature verification
- Canonical frame hash chain.
- Transcript export as JSON.
- In-browser transcript import, verification, and replay controls.
- Offline transcript verifier.
- Early Solidity escrow/dispute/reputation skeleton.
- Pure React DOM rendering; no canvas.

## Requirements

- Node.js 24+
- npm

## Run locally

```bash
npm install
npm run dev
```

Open the Vite URL in two tabs.

1. In tab one, click **Host Tab**.
2. In tab two, click **Joiner Tab**.
3. Copy the host Peer ID into the joiner tab.
4. Click **Connect** in the joiner tab.
5. Click **Start Match**.

For headless smoke testing, build and preview first:

```bash
npm run build
npm run preview
```

Then in another shell:

```bash
PLAYWRIGHT_BROWSERS_PATH=/home/node/.openclaw/workspace/.cache/ms-playwright node self-play.cjs
npm run verify-match -- crypto-fighter-self-play-transcript.json
```

## Controls

- Player 1: `A` left, `D` right, `F` attack
- Player 2: `←` left, `→` right, `/` attack

## Scripts

```bash
npm run dev           # start Vite dev server
npm run build         # typecheck and build production assets
npm run lint          # run ESLint
npm run preview       # preview a production build
npm run verify-match  # verify/replay an exported transcript JSON
```

## Source layout

```text
contracts/
  CryptoFighterArena.sol # escrow, timeout dispute, and reputation skeleton

tools/
  verify-match.mjs       # standalone transcript verifier/replayer

src/
  App.tsx      # React UI and session orchestration
  crypto.ts   # session wallet, packet signing, signature verification, hashing
  game.ts     # deterministic game constants and transition logic
  types.ts    # shared domain/network/transcript types
  format.ts   # small formatting helpers
  main.tsx    # React entrypoint
```

## Transcript replay

The app has a **Transcript replay** panel. Paste an exported transcript JSON or select a `.json` file, then click **Verify + Load**.

The browser verifier checks the same packet chain/signature/frame-hash rules as the offline verifier, then lets you scrub or play back the deterministic match state locally. This is the easiest way to inspect someone else's transcript on your own machine without trusting their UI.

## Contract direction

Two keys per player:

- **Main wallet** (secp256k1, e.g. MetaMask): identity + escrow. It is `msg.sender` on `challenge`/`join`, so committing a session key in that transaction *is* the wallet's delegation of it. Pays the ante.
- **Session key** (ephemeral secp256k1): signs the ~30/sec input packets. Verified off-chain during play; recoverable on-chain when a settlement dispute needs it.

Settlement is **unilateral and optimistic** — no final co-signature (which an opponent could refuse):

1. `challenge(matchId, rulesHash, p1SessionKey, expectedOpponent, window)`: P1 opens escrow, commits its session-key address, and optionally locks the opponent's main wallet. P1 never supplies P2's session key.
2. `join(challengeId, p2SessionKey)`: P2 matches stake and commits its own session-key address.
3. `claimResult(challengeId, outcome, finalFrame, finalHead, p1Head, p2Head)`: either player claims the result. No opponent signature required.
4. `disputeResult(challengeId, p1Next, p2Next)`: within the window, anyone can disprove a claim by revealing a validly co-signed packet pair for the frame *after* the claimed final frame. Both packets must recover (`ecrecover`) to the two committed session keys, so they cannot be forged; their existence proves the match continued. A disproven claimant is slashed and the honest disputer wins the pot.
5. `finalizeResult(challengeId)`: after the window with no dispute, the claim finalizes.
6. Dispute/false-claim events (`ResultDisputed`, `falseResultClaims`) feed the reputation dashboard.

Why the history is enough: every packet a player sent is signed by their own delegated session key, so the winner already holds the loser's signed moves. Settlement uses those existing signatures, not a new cooperative one — a losing player refusing to sign at the end is irrelevant. The only remaining refusal vector is *stalling* (never sending packets), handled by the separate `claimTimeout`/`respondTimeout`/`forfeitTimeout` liveness clock.

This runs on any EVM chain including Ethereum L1: nothing on-chain verifies P-256; all on-chain checks are secp256k1 via `ecrecover`.

Known limitation (next dispute type): the continuation proof catches any "the match didn't end here" lie. A claim at the *true* final frame but with a *wrong outcome* would additionally need an on-chain replay/fraud proof of that final transition; that is intentionally out of scope for this cut.

## Local on-chain testing

The Solidity settlement is exercised two ways, both isolated in `hh/` (a small
Hardhat harness with its own `package.json` so it does not fight the app's ESM):

```bash
npm run test:contract        # deploy to a local EVM; assert happy path + dispute
```

To click through the real UI against a local chain (stand-in for MetaMask):

```bash
# 1. start a local node (unlocked funded accounts)
cd hh && XDG_CACHE_HOME="$PWD/../.cache/xdg" ../node_modules/.bin/hardhat node

# 2. deploy the contract (new shell)
cd hh && XDG_CACHE_HOME="$PWD/../.cache/xdg" ../node_modules/.bin/hardhat run scripts/deploy.cjs --network localhost

# 3. serve the app, connect MetaMask to the local RPC, paste the Arena address
npm run build && npm run preview
```

In the app's **On-chain settlement** panel: Connect Wallet, paste the Arena
address, set a stake, then P1 **Challenge** and P2 **Join**; when a round ends,
P1 **Claim Result** and (after the response window) **Finalize**. The headless
equivalent of this flow lives in `hh/e2e-onchain.cjs`.

## Current verification status

The latest smoke test produced a completed match transcript that the standalone verifier accepted:

```text
frame: 67
winner: P1
verifier: ok=true
```

Lint currently passes with one React hook warning around the interval `tick` closure.
