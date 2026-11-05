# Safe settlement and funded-state exits

This document specifies the economic exits required by Issue #4. It is a design
for the replacement settlement protocol, not a description of functionality
that exists today. The browser still sends no settlement transactions, current
trace verdicts still move no funds, and deployment remains local-only.

## Plain-language policy

- Match terms are fixed before either player begins and cannot change afterward.
- A funded and authorized game has a 24-hour game window.
- A terminal trace claim made during that window starts a fresh 24-hour response
  window.
- Every valid action that completes the current dispute turn starts the next
  24-hour window. Invalid, duplicate, irrelevant, or partial actions do not.
- If nobody submits a trace claim by the game deadline, both antes become
  settled treasury funds.
- If a claim is not challenged in time, its asserted game outcome is accepted.
- During a dispute, responding is the player's responsibility. A missed deadline
  has the published procedural consequence below; the protocol does not decide
  whether the player was malicious, offline, or unable to retrieve evidence.
- An accepted winner receives their own ante back plus the CFC reward reserved
  in the match terms. The loser's ante becomes settled treasury funds.
- An accepted draw returns each player's own ante and releases the unused reward
  reservation back to the reward vault.
- If neither player establishes a usable result, both antes become settled
  treasury funds and the reward reservation is released.
- Expired transitions are permissionless: anyone may execute the already-defined
  result after its deadline.

The owner initially controls policy for future matches and may withdraw only
settled treasury balances. Ownership can later move to a DAO or timelock. Neither
the owner nor a future DAO may alter active-match terms, take active escrow, or
take an already-reserved reward.

## Terms and roles

Every funded match snapshots at least:

- the two main wallets and delegated session keys;
- the canonical rules hash and match context;
- the ante asset and equal amount deposited by each player;
- the promised CFC reward or the rule that computes its fixed reserved amount;
- the game deadline and 24-hour response-window duration; and
- the policy/version identifier governing settlement.

Player 1 and Player 2 identify match participants. Claimant and challenger
identify who submitted the first and second trace in one dispute cycle. Those
roles do not imply winner and loser. Each trace candidate must state a complete
terminal outcome: Player 1 win, Player 2 win, or draw.

The replacement protocol accepts CFC and owner-approved conventional ERC-20
stablecoins. It does not treat the chain's gas coin as CFC. Ranked eligibility,
the exact Fibonacci reward, and CFC issuance are specified separately in Issue
#12; settlement consumes only the snapshotted and already-reserved reward.

## Accounting buckets

Contracts must account for each asset in distinct buckets:

| Bucket | Meaning | Who can withdraw it |
| --- | --- | --- |
| Active escrow | Antes belonging to a match that has not reached a terminal settlement | Nobody |
| Reserved CFC rewards | CFC committed to funded matches that may still produce a winner | Nobody |
| Player credits | Final refunds, returned winner antes, and earned rewards | Only the credited player |
| Settled treasury | Forfeited antes from terminal matches | Owner initially; DAO/timelock later |
| Unreserved reward balance | Reward-vault CFC not promised to an active match | Only through the approved reward-policy controls |

Settlement moves balances between buckets before any external token transfer.
Players withdraw their own credits through a pull-based withdrawal. Treasury
withdrawal likewise transfers only the settled-treasury bucket. An accidental
token transfer does not become active escrow or authorize an extra withdrawal.

There are no separate settlement fees or dispute bonds in this version. Each
caller pays their own transaction fee. Adding fees or bonds requires a new
reviewed policy version and affects only new matches.

## Deadline rules

The authorized-genesis transaction establishes `gameDeadline = authorizedAt +
24 hours`. A valid terminal claim may be submitted at or before that deadline.
Submitting it establishes `responseDeadline = submittedAt + 24 hours`.

For all deadlines:

- an action is timely when the accepted chain timestamp is less than or equal to
  the stored deadline;
- its timeout transition becomes callable only when the timestamp is greater
  than the deadline;
- only a successful state transition can establish a new deadline;
- the first of two required midpoint responses does not extend the shared round;
- completing both midpoint responses starts the next round's 24-hour window; and
- publishing an archive, proving an objective fault, retrying an invalid call, or
  repeating an accepted action does not extend settlement time.

Configured confirmation and reorganization handling remain as described in
[`EVIDENCE_AND_CHAIN_TRUST.md`](EVIDENCE_AND_CHAIN_TRUST.md). A client can wait
for confirmations before displaying an action as final, but canonical on-chain
timestamps determine the contract deadline.

## Outcome rules

Once a candidate outcome is accepted, the participant named by that outcome is
the winner even if the other participant happened to be claimant.

| Accepted result | Player 1 destination | Player 2 destination | Reserved reward | Treasury |
| --- | --- | --- | --- | --- |
| Player 1 wins | Player 1 credit: own ante | No player credit | Credit to Player 1 | Player 2 ante |
| Player 2 wins | No player credit | Player 2 credit: own ante | Credit to Player 2 | Player 1 ante |
| Draw | Player 1 credit: own ante | Player 2 credit: own ante | Release to reward vault | Nothing |
| No established result | No player credit | No player credit | Release to reward vault | Both antes |

Streak advancement/reset is deliberately not hidden in this table. Issue #12
defines it, and the ranked implementation must apply it exactly once when the
economic result becomes terminal.

## Funded-state exit matrix

“Anyone” means any account may execute a deterministic expired transition; the
caller does not receive the funds merely for calling it.

| Funded state | Progress before expiry | Expired exit and caller | Fund destination |
| --- | --- | --- | --- |
| Open offer; only Player 1 funded | Player 2 joins with the exact snapshotted ante | Player 1 may cancel at any time before join | Return Player 1 ante |
| Joined but genesis not authorized | Both session keys authorize the completed binding | After the authorization deadline, anyone refunds | Return both antes; release any reward reservation |
| Authorized; no trace claim | Either participant submits a valid terminal trace candidate | After the game deadline, anyone expires the match | No established result: both antes to treasury; release reward |
| One trace candidate; not challenged | Opponent submits a valid different candidate | After the response deadline, anyone accepts the candidate | Apply its Player 1 win, Player 2 win, or draw result |
| Bisection round; neither midpoint submitted | One or both participants submit the requested valid opening | After the shared deadline, anyone expires the dispute | No established result: both antes to treasury; release reward |
| Bisection round; exactly one midpoint submitted | Other participant supplies the requested valid opening | After the shared deadline, anyone accepts the responding participant's candidate | Apply the surviving candidate's asserted result |
| Bisection round; both midpoints submitted | Contract advances the bracket and starts the next 24-hour round | No timeout remains for the completed round | Escrow remains active |
| Adjacent transition awaiting witness | Either participant supplies the complete valid witness before the deadline | If nobody supplies it, anyone expires the dispute | No established result: both antes to treasury; release reward |
| Step verdict is `Neither` | None; both submitted candidates failed at the isolated step | Immediate terminal transition | No established result: both antes to treasury; release reward |
| Step verdict selects claimant or challenger | Selected candidate survives; verified prefix advances through the canonical step; new 24-hour correction window starts | If no valid corrected countertrace arrives, anyone accepts survivor | Apply survivor's asserted result |
| Correction window | Opponent submits a candidate that agrees through the verified prefix and differs later | After the deadline, anyone accepts the survivor | Apply survivor's asserted result |
| Terminal settlement | Credited players and treasury controller withdraw independently | No state-changing timeout | Only recorded credits/treasury balances can leave |

Every valid corrected countertrace must agree with the already-verified prefix.
A later dispute therefore begins after that prefix, and each successful
one-step verdict advances it. A player cannot replay an earlier disagreement to
restart the clock. The trace has 300 transitions, so successful correction
cycles cannot advance forever.

## Why a one-step verdict does not immediately pay

The existing `StepVerdict` says which submitted checkpoint matches one canonical
transition. It does not prove that the selected trace remains correct at every
later transition. Paying immediately would turn a local fact into authority it
does not have.

Instead, a claimant/challenger verdict selects the surviving candidate, records
the longer verified prefix, and gives the opponent one fresh response window to
submit a corrected later disagreement. If no corrected countertrace arrives,
the surviving outcome is accepted optimistically. If one arrives, the protocol
continues from the verified prefix. This is the concrete meaning of continuing
until the result is teased out.

## Non-response and evidence failures

The protocol records what happened procedurally, not why:

| Situation | Settlement treatment |
| --- | --- |
| No initial claim | No established result after the game deadline |
| Claim not challenged | Accept the claimed outcome after its response deadline |
| One participant alone completes the required round response | Accept that participant's candidate after the shared deadline |
| Neither participant completes the required round response | No established result |
| Neither participant submits the required adjacent-step witness | No established result |
| Lost/withheld/unavailable archive causes a missed action | Apply the same published non-response rule for that state |
| Malformed, stale, duplicate, or invalid action | Reject it; do not reset the deadline |

This intentionally maps several different diagnostic causes to the same exit.
Players remain responsible for retaining evidence and monitoring deadlines.

## Invalid and conflicting evidence

- A forged or unauthenticated packet has no effect.
- Objective invalid-input or equivocation proof remains a separately recorded
  fact. It does not by itself declare the match winner or reset a deadline.
- A trace opening or witness that fails verification is rejected and may be
  corrected before the current deadline.
- If the canonical isolated step matches neither candidate, both candidates are
  unusable and the match terminates with no established result.
- Two different candidate traces do not both become winners. Their first
  disagreement is isolated under the deterministic game rules.

## Required safety and liveness invariants

An implementation is not settlement-complete unless all of these hold:

1. Active terms are immutable and include the exact asset, ante, reward, policy,
   participants, rules, and deadlines.
2. Sum-of-buckets accounting prevents active escrow or reserved rewards from
   being withdrawn as treasury.
3. Every funded state has a permissioned progress action and a deterministic,
   permissionless expired exit.
4. Invalid or partial actions cannot extend a deadline.
5. A terminal match is settled exactly once; replay cannot duplicate credits,
   treasury accrual, rewards, or streak changes.
6. A one-step verdict cannot authorize a complete outcome without the correction
   window and monotonic verified-prefix rule.
7. Practice evidence and unactivated bindings can never enter settlement.
8. Pull withdrawals update accounting before transferring tokens and are safe
   against reentrancy.
9. An owner or future DAO can change only future policy and withdraw only the
   settled-treasury bucket.
10. Reward exhaustion prevents match creation; it never reduces a reward after
    players have funded the match.

## Remaining decisions owned elsewhere

- Issue #12: Fibonacci indexing, rank eligibility, draw/expiration streak
  effects, issuance, reward-vault funding, and future seasonal policy.
- Issue #13: exact CFC, vault, treasury, ownership-transfer, and withdrawal
  interfaces.
- Issue #14: Solidity state layout and implementation of this state machine,
  including challenger outcomes, correction cycles, deadlines, and ERC-20
  accounting.
- Production deployment: supported network, confirmation rule, audited contract
  version, stablecoin allowlist, and migration/versioning plan.

Until those pieces are implemented, tested, audited as appropriate, and
reviewed, `settlementEligible: false` and local-only deployment remain mandatory.
