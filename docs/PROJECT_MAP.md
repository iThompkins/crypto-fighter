# Project map

## What Crypto Fighter is

Crypto Fighter is a prototype for a two-player fighting game. Each player runs
the same game in a browser. The browsers exchange signed button presses and use
the same rules to calculate movement, attacks, health, and the winner.

The project also asks a harder question: if the browsers later disagree about
the match, can they prove which game step was calculated correctly without
putting the whole match on a blockchain? The implemented answer is:

1. save the signed messages needed to reconstruct the match;
2. turn the reconstructed match into a compact timeline;
3. narrow two conflicting timelines to one game step; and
4. recalculate that one step in a contract.

That is where the system stops today. It can record which proposed version of a
disputed step follows the game rules. It does not yet turn that answer into a
payout, refund, or penalty. Everything involving contracts is restricted to a
local Hardhat test chain, the browser sends no contract transactions, and this
project must not be used with real funds.

## The story of one match

Suppose Alice and Bob want to play. Alice will be Player 1 and Bob will be
Player 2. The contract flow described below exists for local testing; the
browser does not currently send settlement transactions.

### 1. Player 1 creates a challenge

A challenge is an invitation to one match. Alice's main wallet creates it with:

- a new random match ID;
- the amount each player would deposit in the local test;
- the time allowed for later responses;
- an optional restriction saying that only Bob may join; and
- Alice's session key.

A session key is a temporary signing key made for this match. It lets the game
sign frequent messages without asking Alice's main wallet for approval every
frame. Its private key stays in browser memory and is not saved.

At this point Bob is not known unless Alice restricted the opponent. The
contract therefore has an open invitation, not a complete description of the
match.

### 2. Player 2 joins

Bob joins with the same deposit and supplies his own session key. The contract
now knows both main wallets, both session keys, the match ID, the game version,
the test stake, and the response window. Those facts no longer change for this
match.

### 3. Both session keys approve the completed match

The code calls the completed match description a `GenesisBinding`. Think of it
as the match's signed cover sheet. It identifies the network and arena contract,
the challenge and match, both players and their session keys, the one allowed
game version, and the escrow terms.

Here, escrow terms simply means the local test deposit and the response window.
Both signatures are required so neither player can attach the other player's
session key to match terms that only one side accepted.

Alice's and Bob's session keys each sign this cover sheet. The arena checks both
signatures before marking the match authorized.

This one-time approval gives meaning to the short match ID used during play. A
button-press message does not repeat the contract address, players, and stake.
The two cover-sheet signatures prove which complete match those shorter
messages belong to. They authorize this match setup; they do not approve a
winner or a payout.

### 4. The players sign button presses while playing

Before the first frame, each session key signs a READY message for this match.
During the match, each key signs input packets. An input packet is a statement
such as:

> For match M, at frame 150, Player 1 pressed attack.

More exactly, the signed data contains the match ID, frame number, player slot,
button value, a fingerprint of that player's previous packet, and a fingerprint
of the opponent's packet from two frames earlier. Those links expose missing,
reordered, or conflicting statements. The game advances a frame only when it
has the valid Player 1 and Player 2 packets for that frame.

The important distinction is that players sign inputs, not results. A signature
proves that a session key made a particular input statement. It does not prove
that the input was used, that the frame ran, that a player won, or that anyone
should be paid.

### 5. Durable evidence keeps the match reconstructable

Durable evidence means public match information that has finished being written
to the browser's IndexedDB database. The browser saves its own signed message
before sending it. It saves an incoming message before using or acknowledging
it. If that write fails, play stops.

The saved journal contains the match description, both READY messages, signed
input packets, and a small number of connection observations. It does not
contain session private keys or saved game-state snapshots.

This ordering matters after a crash or disconnect: a browser should not rely on
a message that it can no longer produce as evidence. Reconstruction examines
the whole supplied journal, including conflicting signed packets; it cannot
quietly choose whichever history is more convenient.

### 6. An execution trace is a compact timeline

After a complete match has been reconstructed, the code builds an execution
trace. A trace is a list of checkpoints: one for the starting position and one
after every possible game frame, for 301 checkpoints in total.

A checkpoint is a fingerprint of the game state at that point plus the recent
input-history links needed to check the next step. If the fight ends before
frame 300, the final checkpoint is repeated to the end. Repetition creates a
common comparison length; it does not mean that extra moves were played.

The checkpoints are combined into one final fingerprint called a Merkle root.
A player can later reveal any checkpoint with a short Merkle proof showing that
it came from that root. Once submitted, the root prevents the player from
changing that timeline. It does not, by itself, prove that the timeline was
calculated correctly.

### 7. Two different histories are narrowed to one transition

Now suppose Alice and Bob submit different trace roots:

- They agree on the match through checkpoint 149. At that point Bob has 4 health,
  Alice is close enough to hit him, and Alice has no attack cooldown.
- Alice's history says that at frame 150 she attacked and Bob's health became 3.
- Bob's history says that no attack happened and his health remained 4.
- Their histories remain different through the final checkpoint.

The contract knows only that checkpoint 0 agrees and checkpoint 300 differs. It
asks both players to reveal the same middle checkpoint from their already-fixed
roots. At checkpoint 150 they differ, so the upper end moves down to 150. At
checkpoint 75 they agree, so the lower end moves up to 75. Repeating this gives:

`0–300 → 0–150 → 75–150 → 112–150 → 131–150 → 140–150 → 145–150 → 147–150 → 148–150 → 149–150`

This repeated halving is called bisection. The result is one adjacent pair: an
agreed checkpoint before frame 150 and two proposed checkpoints after it. The
contract now needs to check only the transition from 149 to 150, not replay the
entire match. Each revealed checkpoint comes with a Merkle proof tying it to the
player's original root.

### 8. GameTransitionVerifier decides the correct next checkpoint

`GameTransitionVerifier` is the one-frame game calculation written in Solidity,
the language used by the contracts. For the transition from 149 to 150, it
checks:

- that the agreed state before the step is well formed;
- that both packets name this match, frame 150, and the correct player slots;
- that their earlier-packet links are correct;
- that Alice's and Bob's approved session keys signed them; and
- that the button values are valid.

Suppose the signed packets show that Alice pressed attack and Bob pressed
nothing. Given the agreed positions and Alice's available attack, the verifier
applies the game rules once and calculates Bob's health as 3. Alice's proposed
checkpoint matches that calculation and Bob's does not.

The player who submitted the original trace claim is the claimant; the opponent
who submitted a different trace is the challenger. The dispute contract records
`Claimant` if the claimant's checkpoint matches, `Challenger` if the
challenger's matches, or `Neither` if neither does. These labels answer only,
“Which proposed next checkpoint follows the rules?” They do not decide who
deserves money, and they do not prove every other step in either history.

### 9. The implemented system stops at adjudication

Today the project can authenticate the match, retain public evidence,
reconstruct a conflict-free history, commit to a trace, narrow two different
traces to one transition, and calculate the correct result of that transition.
That is adjudication: deciding what happened at the isolated game step.

Settlement is later work. The project has no approved rules saying how a trace
verdict affects deposits, what an unchallenged claim means, what happens when a
player does not respond, or how every funded match eventually pays out or
refunds. A correct technical verdict is therefore deliberately disconnected
from economic consequences.

## What is built today

- One deterministic fighting game lasting at most 300 frames. Its browser and
  Solidity implementations use the same integer rules.
- Two-player browser play using temporary session keys and signed, linked input
  packets.
- Local challenge, join, and two-session authorization of a completed
  `GenesisBinding`.
- Browser evidence storage before messages are sent or used.
- Whole-journal validation and reconstruction without choosing a convenient
  conflicting branch.
- Fixed-length traces, Merkle roots, and proofs for individual checkpoints.
- A local contract dispute that bisects two traces and recalculates one step.

## What is not built today

- A safe connection from a trace verdict to a payout, refund, or penalty.
- Complete rules for silence, missing evidence, unavailable archives, or a
  `Neither` verdict.
- A guaranteed exit from every state in which test funds are locked.
- A production model for chain finality, reorganizations, or trusted RPC data.
- Public-chain deployment, real-money use, token economics, or reputation.

## The current contract boundary

The [protocol-boundary guide](PROTOCOL_BOUNDARY.md) is the authoritative API
classification and explains how the Solidity source contracts compose into the
arena deployment.

`CryptoFighterArena.sol` now contains only the shared challenge/genesis lifecycle
and current trace context. The older optimistic-result and gameplay-timeout
payout APIs, related state, and disabled browser handlers were removed in Issue
#9. There are no compatibility stubs and no current result-to-funds function.

There is also a provisional `matchContextHash` when Alice first creates a
challenge, because Bob is not known yet. When Bob joins, the contract replaces
it with the completed `GenesisBinding` hash. Authorization changes a separate
boolean; it does not change the completed hash again. Only the completed and
independently verified authorized value can be used as the trace context. See
the exact [`matchContextHash` lifecycle](PROTOCOL_BOUNDARY.md#matchcontexthash-lifecycle).

## Where the important code lives

| Concern | Start here | What it owns |
| --- | --- | --- |
| Game rules | [`src/game.ts`](../src/game.ts), [`src/protocol.ts`](../src/protocol.ts) | Starting state, one-frame calculation, game version, and state hashing. |
| Browser match | [`src/live-match.ts`](../src/live-match.ts), [`src/live-protocol.ts`](../src/live-protocol.ts) | READY/input handling, signing order, reconnects, and persistence before use. |
| Match authorization | [`src/genesis.ts`](../src/genesis.ts), [`contracts/CryptoFighterArena.sol`](../contracts/CryptoFighterArena.sol) | `GenesisBinding`, both session approvals, challenge, and join. |
| Saved evidence | [`src/evidence-store.ts`](../src/evidence-store.ts), [`src/evidence-archive.ts`](../src/evidence-archive.ts) | IndexedDB writes and whole-journal reconstruction. |
| Trace creation | [`src/evidence-trace.ts`](../src/evidence-trace.ts), [`src/execution-trace.ts`](../src/execution-trace.ts) | Checkpoints, roots, proofs, and dispute-ready evidence. |
| Trace disagreement | [`src/bisection.ts`](../src/bisection.ts), [`contracts/TraceDispute.sol`](../contracts/TraceDispute.sol) | Midpoint comparison, deadlines, and the neutral verdict. |
| One-step calculation | [`contracts/GameTransitionVerifier.sol`](../contracts/GameTransitionVerifier.sol), [`src/onchain-dispute.ts`](../src/onchain-dispute.ts) | Contract game rules and preparation of the isolated-step data. |
| Evidence and chain trust | [`EVIDENCE_AND_CHAIN_TRUST.md`](EVIDENCE_AND_CHAIN_TRUST.md), [`PHASE_B.md`](PHASE_B.md), [`PHASE_C.md`](PHASE_C.md) | Required evidence, retention responsibility, availability failures, RPC/finality assumptions, and reorg handling. |
| Safety boundary | [`PROTOCOL_BOUNDARY.md`](PROTOCOL_BOUNDARY.md), [`INVARIANTS.md`](INVARIANTS.md), [`ROADMAP.md`](ROADMAP.md) | Current/legacy API status, rules changes must preserve, and work that remains. |

## Short glossary

- **Main wallet:** A player's ordinary blockchain account. It identifies the
  player and handles the local test deposit.
- **Session key:** A temporary in-memory key that signs messages for one match.
- **Match ID:** A fresh random identifier separating one match's messages from
  every other match.
- **GenesisBinding:** The completed cover sheet connecting a match ID to the
  contract, players, session keys, game version, and escrow terms.
- **Input packet:** One player's signed button-press statement for one frame.
- **Durable evidence:** Public match data saved successfully before the browser
  sends it or relies on it.
- **Checkpoint:** A fingerprint of the game state and recent input history at one
  point in the match.
- **Execution trace:** The ordered list of checkpoints for a match.
- **Merkle root/proof:** One fingerprint for the whole trace, plus a short proof
  that a particular checkpoint belongs to it.
- **Bisection:** Repeatedly halving a disagreement until one transition remains.
- **Adjudication:** Recalculating that transition and recording which proposed
  next checkpoint, if any, is correct.
- **Settlement:** The unimplemented rules that would turn claims, silence, and
  adjudication results into payouts or refunds.
