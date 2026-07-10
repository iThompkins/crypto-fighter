# Crypto Fighter

A React + TypeScript + Vite MVP for a tiny peer-to-peer fighting game with signed frame inputs, strict off-chain realtime verification, transcript export, and an early escrow/dispute contract sketch.

Two browser tabs connect through PeerJS. Each tab generates an ephemeral ECDSA P-256 session wallet, signs one local input packet for the next frame, verifies the remote player's packet, and only advances deterministic game state when both valid packets for the next canonical frame are present.

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
- Signed per-frame input packets using Web Crypto ECDSA P-256.
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

The intended settlement shape is:

1. `challenge(...)`: P1 opens escrow with stake, rules hash, and session key commitment.
2. `join(...)`: P2 matches stake and commits session key.
3. Happy path: both players sign final result and call `submitFinalResult(...)`.
4. Naughty/stalled path:
   - honest player calls `claimTimeout(...)` with latest transcript head and next packet commitment.
   - accused player has a response window, e.g. 24 hours, to call `respondTimeout(...)` and continue the chain.
   - if they fail, `forfeitTimeout(...)` awards the match to the claimant.
5. Contract events feed a searchable reputation dashboard.

Important caveat: the browser currently uses P-256 session signatures. Ethereum wallet signatures are secp256k1. For production, final settlement should either use wallet signatures for final results, use secp256k1-compatible session keys, or deploy on a chain/verifier that supports P-256 packet verification.

## Current verification status

The latest smoke test produced a completed match transcript that the standalone verifier accepted:

```text
frame: 67
winner: P1
verifier: ok=true
```

Lint currently passes with one React hook warning around the interval `tick` closure.
