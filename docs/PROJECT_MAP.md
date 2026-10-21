# Project map

## What Crypto Fighter is

Crypto Fighter is a local-only prototype for a two-player fighting game. The two
players run the same game rules in their browsers and exchange signed button
presses. If both browsers receive the same valid inputs, they independently reach
the same result.

The project also explores how the players could prove what happened without
putting the whole match on a blockchain. Each browser saves the signed messages
it sees. From those messages it can build a compact summary of every game step.
If two summaries disagree, the contracts can narrow the disagreement to one step
and recalculate that step.

That proof machinery works in local tests. Safe settlement does not. The code
does not yet turn a disputed-step result into a payout, handle every missing-player
case, or provide a safe way out of every funded state. Browser settlement actions
are disabled, deployment is limited to the in-process Hardhat chain, and no part
of this repository should be used with real funds.

## The story of one match

The escrow steps below describe the implemented local contract flow. The browser
can play and prepare artifacts, but its settlement transaction buttons are
intentionally disabled.

### 1. Player 1 creates a challenge

Player 1 chooses a fresh match ID, creates a temporary session key for this
match, chooses a stake and response window, and optionally names the only wallet
allowed to join. The local arena contract records those facts and holds Player
1's deposit.

The match ID separates this match's signed inputs from every other match. The
session key is a temporary signing key used for game messages; it is separate
from the main wallet that created and funded the challenge.

### 2. Player 2 joins

Player 2 joins with an equal deposit and a different temporary session key. At
this point the arena knows both main wallets, both session keys, the match ID,
the game version, the stake, and the response rules. It freezes those facts so
they cannot be changed halfway through the match.

### 3. GenesisBinding says exactly which match the session keys accepted

`GenesisBinding` is the code's name for that frozen match description. In
ordinary terms, it is the cover sheet attached to all later game evidence. It
contains the blockchain network and arena contract, challenge number, match ID,
game version, both main wallets, both session keys, stake, response window, and
any opponent restriction.

Each session key signs the completed cover sheet for its player slot. The arena
checks both signatures and marks the match authorized. This matters because a
signed button press only names a short match ID; it does not repeat the wallets,
stake, or contract address. The one-time `GenesisBinding` signatures prove which
full match that short ID belongs to. They approve this exact match setup, not a
winner or payout.

The main wallets authorize deposits and identify the participants. The session
keys authorize the fast, repeated game messages without asking a wallet extension
to sign every frame. Session private keys stay in memory and are never saved.

### 4. During play, the players sign inputs, not results

Before play, each session key signs a READY message for this exact match. During
play, each player signs small input packets. A packet says:

- which match, frame, and player slot it belongs to;
- which buttons were pressed, represented by a number from 0 to 15;
- a hash (short digital fingerprint) of that player's previous packet; and
- the hash of the opponent packet from two frames earlier.

Those links make missing, reordered, or conflicting statements detectable. A
valid pair of Player 1 and Player 2 packets advances the game by one frame. A
signature proves that a session key made a statement; it does not prove that the
frame was actually played. Players do not sign the game state, final winner, or
settlement instruction during normal play.

### 5. Durable evidence preserves the public history

Before a browser sends one of its own signed messages, or uses an incoming
message to advance the game, it writes that message to an evidence journal in
the browser's IndexedDB database. "Durable" means the database transaction has
completed, so a reload or disconnect does not leave the browser relying only on
memory.

The journal keeps the match description, signed READY messages, signed input
packets, and limited connection observations. It does not store session private
keys or mutable snapshots of the game. The saved public history exists so the
match can be reconstructed later, including inconvenient facts such as two
different packets signed for the same player and frame. Storage failure stops
play instead of letting unsaved actions gain authority.

### 6. An execution trace is a compact timeline of the match

After a complete, conflict-free match, the journal can be checked and replayed.
That replay produces an execution trace: 301 numbered checkpoints, one for the
starting position and one for every possible frame through frame 300.

Each checkpoint is a compact fingerprint of the game state and the latest packet
fingerprints needed to verify the next step. If a match ends early, its final
checkpoint is repeated through frame 300; those repeats do not pretend that more
moves occurred.
The checkpoints are placed in a Merkle tree, a hash tree that produces one root
hash. That root acts like a receipt for the complete ordered timeline while
allowing any individual checkpoint to be revealed with a short proof.

The root alone does not prove that the timeline is correct. It only prevents a
player from changing that committed timeline later.

### 7. Two conflicting traces are narrowed to one disputed step

Suppose both players submit trace roots. Their checkpoints match from the start
through frame 149, but differ from frame 150 onward. The contract does not replay
all 300 frames. It asks both players to reveal the checkpoint halfway through the
remaining range:

1. At frame 150 the checkpoints differ, so the disputed step is at or before 150.
2. At frame 75 they match, so it is after 75.
3. They also match at 112, 131, 140, 145, 147, 148, and 149.
4. The remaining range is now frame 149 to frame 150.

This repeated halving is called bisection. The two traces agree on the state
before the step and disagree on the state after it, so only frame 150 needs to be
recalculated. Merkle proofs show that every revealed checkpoint really belongs
to the root each player submitted.

### 8. GameTransitionVerifier recalculates that one step

`GameTransitionVerifier` is the copy of the one-frame game rules written in
Solidity, the contract language used here. It checks that the agreed pre-step
state is well formed; that both packets belong to the right match, frame, and
player slots; that their button masks and history links are valid; and that the
committed session keys signed them. It then applies the game rules once and
calculates the correct checkpoint after frame 150.

The surrounding dispute contract compares that calculated checkpoint with both
submitted traces. It records one of three neutral facts: the recalculated step
matches the claimant's trace, matches the challenger's trace, or matches neither.
It does not declare an economic winner.

### 9. The implemented system stops before settlement

This is the current stopping point: local code can authenticate the match, retain
its evidence, reconstruct it, compare two trace commitments, isolate one step,
and record which proposed next checkpoint is correct.

Settlement would add the missing economic policy and safe exits. It would define
what an unchallenged claim means, what each disputed-step result does to the
deposits, what happens when a player never responds or evidence is unavailable,
and how every funded match eventually returns or pays out funds. None of that is
connected to the trace verdict today.

## What is built today

- **Deterministic game:** both browsers and Solidity use matching integer-based
  rules for movement, attacks, health, timer, and outcome.
- **Signed live play:** two browser peers authenticate readiness and linked input
  packets with temporary session keys.
- **Durable evidence:** public match messages are saved before they are sent or
  used, and can be recovered for inspection after reload.
- **Evidence reconstruction:** the full supplied journal is validated and
  replayed without trusting row order or selecting a convenient conflicting
  branch.
- **Trace commitments:** a complete match becomes a 301-checkpoint Merkle tree
  with short proofs for individual checkpoints.
- **Local dispute:** contracts accept two fixed roots, halve the disagreement to
  one step, and independently recalculate that step.
- **Local genesis authorization:** both session keys approve one completed match
  binding, and the trace is tied to that binding.

## What is not built today

The **game, evidence, and dispute** layers are implemented for local testing: play
the match, save what was signed, reconstruct the history, and determine the
correct result of one disputed step.

The **settlement and economics** layer is not implemented safely. There is no
approved rule connecting a trace verdict to a payout, no complete non-response
policy, no guarantee that required evidence will remain available, no production
chain-finality model, and no objective exit from every funded state. Public-chain
deployment, real-money use, fees, token economics, and reputation consequences
are also outside the implemented system.

## What old code can confuse me

`CryptoFighterArena.sol` still contains an older result and timeout settlement
experiment:

- `claimResult` lets a participant state an outcome, and `finalizeResult` can pay
  it after a waiting period if nobody uses the old challenge path.
- `disputeResult` treats signed packets for the next frame as a reason to reject
  that result and pay the opponent. Those packets may have been signed ahead of
  time without ever being played, so they do not prove the claimed result false.
- `claimTimeout`, `respondTimeout`, and `forfeitTimeout` use loosely connected
  chain-head values to assign a timeout win. They do not establish who caused a
  stall or connect safely to the new evidence and trace flow.

These functions can move local test funds, but they are unsafe legacy scaffolding.
They are mutually excluded from an active trace claim and must not be read as the
settlement half of the trace dispute system. The browser transaction actions are
disabled.

`matchContextHash` has another historical wrinkle. When Player 1 first calls
`challenge`, Player 2 is not known, so the contract stores a temporary hash made
from the facts available at that time. When Player 2 joins, the contract replaces
it with the hash of the complete `GenesisBinding`. Only this second, complete hash
can be authorized by both session keys and used as the trace context. Code or
events that observe the first value must not mistake it for the final match
binding.

## Where the important code lives

| Concept | Important files | What to look for |
| --- | --- | --- |
| Game rules and state encoding | [`src/game.ts`](../src/game.ts), [`src/protocol.ts`](../src/protocol.ts) | Initial state, one-frame transition, game-version fingerprint, and state hash. |
| Browser match lifecycle | [`src/live-match.ts`](../src/live-match.ts), [`src/live-protocol.ts`](../src/live-protocol.ts) | READY/input admission, signing, persistence-before-use, reconnect, and recovery. |
| Session signatures and packet hashes | [`src/crypto.ts`](../src/crypto.ts), [`src/types.ts`](../src/types.ts) | Temporary keys, signed packet fields, and shared data shapes. |
| GenesisBinding | [`src/genesis.ts`](../src/genesis.ts), [`contracts/CryptoFighterArena.sol`](../contracts/CryptoFighterArena.sol) | Binding hash, two-session authorization, challenge/join, and the provisional/final context change. |
| Durable journal | [`src/evidence-store.ts`](../src/evidence-store.ts), [`src/match-evidence.ts`](../src/match-evidence.ts) | IndexedDB commit boundary and signed-packet chain validation. |
| Reconstruction and dispute bundle | [`src/evidence-archive.ts`](../src/evidence-archive.ts), [`src/evidence-trace.ts`](../src/evidence-trace.ts) | Whole-journal replay, conflict handling, and regeneration of proofs and step witnesses. |
| Trace and Merkle proofs | [`src/execution-trace.ts`](../src/execution-trace.ts), [`contracts/TraceCommitmentVerifier.sol`](../contracts/TraceCommitmentVerifier.sol) | The 301 checkpoints, root construction, and checkpoint membership proofs. |
| Narrowing a disagreement | [`src/bisection.ts`](../src/bisection.ts), [`contracts/TraceDispute.sol`](../contracts/TraceDispute.sol) | Midpoint rounds, deadlines, and the final neutral verdict. |
| One-step recalculation | [`contracts/GameTransitionVerifier.sol`](../contracts/GameTransitionVerifier.sol), [`src/onchain-dispute.ts`](../src/onchain-dispute.ts) | Solidity game step and conversion of evidence into contract call data. |
| Browser composition | [`src/App.tsx`](../src/App.tsx), [`src/chain.ts`](../src/chain.ts) | Peer/UI wiring, evidence export, and deliberately disabled settlement actions. |
| Current boundaries | [`INVARIANTS.md`](INVARIANTS.md), [`ROADMAP.md`](ROADMAP.md), [`DECISIONS.md`](DECISIONS.md) | Review rules, remaining work, and durable architectural choices. |

## Glossary

- **Genesis:** The fresh match ID and starting anchor that separates one match's
  signed messages from every other match.
- **GenesisBinding:** The immutable cover sheet connecting a genesis to the
  chain, arena, challenge, players, session keys, game version, and escrow terms.
- **Session key:** A temporary key used to sign match messages. It is delegated
  for one match and is separate from the main wallet that holds funds.
- **Packet:** One player's signed input statement for one frame, including links
  to earlier packets. A packet proves a statement was signed, not that it ran.
- **Evidence journal:** The durable local record of public match facts, especially
  signed readiness and input messages. Private keys are never part of it.
- **Trace:** An ordered list of compact checkpoints covering the starting state
  and every possible game frame.
- **Checkpoint:** A hashable summary of the game state and input-history heads at
  one trace position.
- **Merkle root:** One hash that commits to all ordered trace checkpoints. A short
  proof can show that a checkpoint belongs to that root.
- **Bisection:** Repeatedly comparing the middle checkpoint of a disputed range
  until only one game step remains.
- **Adjudication:** Independently checking that isolated step and recording which
  submitted next checkpoint, if either, matches the rules.
- **Claimant:** The participant who submits the first trace root and terminal
  state to the dispute contract.
- **Challenger:** The opponent who submits a different trace root for the same
  authorized match.
- **Durable evidence:** Public match data that has completed a persistent storage
  transaction before the application sends it or relies on it.
- **Settlement:** The still-missing policy and contract behavior that would turn
  claims, verdicts, silence, and failures into safe payouts or refunds.
