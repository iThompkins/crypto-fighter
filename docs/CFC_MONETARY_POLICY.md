# CFC monetary policy and ranked Fibonacci rewards

This document specifies the product and accounting policy required by Issue
#12. It is not implemented. CFC does not exist in the repository yet, current
escrow accepts only valueless local gas coin, and no current trace result can
pay a reward.

## Launch policy in plain language

- Crypto Fighter Coin (`CFC`) is an 18-decimal ERC-20 game token.
- The initial owner controls issuance, reward funding, treasury withdrawals, and
  policy versions. Those powers can later transfer to a DAO/timelock.
- CFC has no fixed maximum supply. New issuance happens in explicit owner-approved
  batches, never automatically because somebody reports a win.
- Ranked play requires exactly 1 CFC from each player.
- Ranked opponents must have the same current win streak when the offer is
  created and when it is joined.
- A ranked winner gets their own 1 CFC ante back plus the next Fibonacci reward.
  The loser ante becomes treasury funds and the loser streak resets to zero.
- A verified draw sends both antes to treasury, pays no reward, and preserves
  both streaks.
- A funded match that ends with no established result pays no reward, sends both
  antes to treasury, and resets both streaks.
- Approved stablecoin matches are unranked. Their winner receives their own ante
  back plus a flat 1 CFC reward; they never advance or reset a ranked streak.
- The full promised reward is reserved before a match offer becomes joinable.
  If the vault cannot reserve it, the match cannot start.
- Stablecoin acceptance does not redeem CFC for one dollar and does not promise
  a dollar floor or peg.

Practice games remain off-contract, use no asset, and cannot affect streaks or
rewards.

## Token and authority model

The launch token is a conventional fungible ERC-20 named **Crypto Fighter Coin**
with symbol **CFC** and 18 decimals. “Game token” is the accurate term when CFC
runs on another chain; it is not that chain's native gas coin.

There is no immutable supply cap in this policy. The Fibonacci rule is intended
to be conceptually uncapped, and future community monetary policy may fund new
competition. Instead of silently minting at settlement, the token owner mints
visible batches. A batch can fund the reward vault, seed an explicitly disclosed
distribution, or implement another published owner decision. ERC-20 `Transfer`
events from the zero address expose every issuance.

Initially, the owner is the project operator. The owner may:

- mint disclosed CFC batches;
- fund or withdraw only the unreserved part of the reward vault;
- withdraw settled treasury balances;
- approve conventional stablecoin assets and future-match ante amounts;
- publish a new policy version for future offers;
- pause creation/join of new funded matches in an emergency; and
- begin a two-step transfer of each privileged contract to a new owner.

The owner may not:

- alter a funded offer or active match;
- reduce or withdraw a reserved reward;
- take active escrow or player credits;
- rewrite a streak or settled result;
- make a policy version retroactive; or
- block player withdrawals or deterministic settlement of already-funded matches.

A future DAO/timelock receives the same bounded contract roles through ordinary
two-step ownership transfer. DAO membership and voting weights are deliberately
not encoded as token rights today. The later community may choose CFC voting,
earned reputation, membership shares, or a hybrid without redeploying the arena
or moving player balances.

## Ranked eligibility

A player has one nonnegative `rankedStreak`, initially zero. A ranked match is
eligible only when all of these are true:

1. both antes are exactly `1 CFC`;
2. the main wallets are different;
3. both snapshotted streaks are equal;
4. neither player already has another unsettled ranked match; and
5. the full next-win reward is successfully reserved.

The single-active-ranked-match rule prevents one streak value from being pledged
into several simultaneous advancement attempts. Exact streak equality creates
the intended tournament thinning: a streak-8 player cannot advance by defeating
a streak-0 account. Matchmaking reputation or a future rating may help players
find opponents, but it cannot override on-chain streak eligibility.

The offer snapshots both streaks and its reward. If either player's streak
changes before join, the offer is stale and cannot be joined; its creator must
cancel or replace it. Once joined, later policy changes cannot change eligibility
or reward.

Repeated opponents are not separately prohibited. After a decisive match their
streaks differ, so they cannot immediately rematch for advancement. Cooperating
wallets can still build a pool of eligible accounts, but doing so requires an
exponentially larger pool, 1 CFC at risk per match, and the published settlement
time. General identity or Sybil prevention is outside this policy.

## Exact Fibonacci rule

Use the standard positive Fibonacci sequence:

```text
F(1) = 1
F(2) = 1
F(n) = F(n - 1) + F(n - 2)
```

For a match whose players both begin at streak `s`, the next-win reward is
`F(s + 1)` CFC. The winner's new streak is `s + 1`; the loser resets to zero.

| Starting streak | Next-win reward | Winner's new streak |
| ---: | ---: | ---: |
| 0 | 1 CFC | 1 |
| 1 | 1 CFC | 2 |
| 2 | 2 CFC | 3 |
| 3 | 3 CFC | 4 |
| 4 | 5 CFC | 5 |
| 5 | 8 CFC | 6 |
| 6 | 13 CFC | 7 |
| 7 | 21 CFC | 8 |
| 8 | 34 CFC | 9 |
| 9 | 55 CFC | 10 |
| 10 | 89 CFC | 11 |

The duplicate opening `1, 1` is intentional standard Fibonacci indexing. It
keeps the first two ranked rewards at the base amount before growth accelerates.

There is no policy-level streak cap. The implementation must use checked integer
arithmetic. If the next reward cannot be represented or fully reserved, no offer
at that streak can be created. It must not wrap, truncate, substitute a smaller
reward, or reset a streak merely because funding is unavailable.

## Terminal streak consequences

Streak state changes only once, as part of terminal economic settlement:

| Terminal result | Player 1 streak | Player 2 streak | Reward |
| --- | --- | --- | --- |
| Player 1 wins | Increment from snapshotted equal streak | Reset to 0 | Reserved Fibonacci reward to Player 1 |
| Player 2 wins | Reset to 0 | Increment from snapshotted equal streak | Reserved Fibonacci reward to Player 2 |
| Verified draw | Preserve | Preserve | Return reward reservation; both antes go to treasury |
| No established result | Reset to 0 | Reset to 0 | Return reservation to vault |
| Offer cancelled before join | Unchanged | Unchanged | Return reservation to vault |
| Joined match never authorized | Unchanged | Unchanged | Return reservation to vault |

Resetting both players after no established result prevents a player from
preserving a valuable streak by withholding the evidence needed to decide a
match. A verified draw preserves both streaks because the protocol established
a real game outcome, but its two antes still become treasury funds.

Stablecoin and other unranked matches never read or write `rankedStreak`, even if
their winner receives the flat base CFC reward.

Because a stablecoin match contributes no forfeited CFC ante, its 1 CFC reward
is a pure draw on the prefunded reward budget. Owner/DAO reporting must count
ranked and stablecoin-match reward obligations separately.

## Reward reservation and exhaustion

The reward vault holds actual CFC. A ranked offer atomically reserves its exact
Fibonacci reward when created. A stablecoin offer similarly reserves its flat
1 CFC reward. Reserved CFC is unavailable to the owner, treasury, and every
other offer.

At terminal settlement, exactly one of these happens:

- decisive result: credit the reserved reward to the accepted winner;
- draw or no established result: release it to the vault's available balance;
- cancellation/unactivated refund: release it without changing either streak.

If available vault CFC is less than the promised reward, offer creation reverts.
The owner may mint/fund another disclosed batch and try again. Existing funded
matches never depend on a later mint and never receive a reduced payout.

This design separates monetary policy from adjudication: a game result can spend
only CFC that already exists and was reserved for it.

## Aggregate reward mathematics

Assume fair outcomes, exact same-streak matching, no draws, and a cohort large
enough to keep pairing winners. At win level `n`:

- only `1 / 2^n` of the starting players win at that level; and
- each winner receives `F(n)` CFC.

Expected gross rewards per starting player are therefore:

```text
F(1)/2 + F(2)/4 + F(3)/8 + ... = 2 CFC
```

Each decisive match also eliminates one player from the advancing cohort and
moves that player's 1 CFC ante to treasury. The expected forfeited ante approaches
1 CFC per starting player.

An eight-player example stops after three levels:

| Level | Winners | Reward each | CFC rewards | Loser antes to treasury |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 4 | 1 | 4 | 4 |
| 2 | 2 | 1 | 2 | 2 |
| 3 | 1 | 2 | 2 | 1 |
| **Total** |  |  | **8** | **7** |

The individual reward is uncapped in policy, but the probability/population able
to reach it shrinks faster than Fibonacci grows. This keeps expected aggregate
reward finite under the exact-tier assumptions. It does not guarantee a market
price or prevent every form of coordinated play.

## Supply and circulation accounting

The following terms are different:

- **Total supply:** every minted CFC that has not been burned, including CFC in
  the reward vault and treasury.
- **Available reward balance:** vault CFC not reserved for a funded offer.
- **Reserved rewards:** vault CFC promised to active offers/matches.
- **Treasury balance:** forfeited CFC the owner/DAO may later withdraw.
- **Circulating outside protocol contracts:** CFC held by players, contributors,
  markets, and other external accounts.
- **Burned:** CFC permanently destroyed, reducing total supply.

Moving a loser ante into treasury does not burn it. While retained, it reduces
external circulation; withdrawal and spending can return it to circulation.
Paying rewards from a previously minted vault also does not mint at settlement.
Only an explicit owner/DAO mint increases total supply.

For intuition, if reward-vault issuance tracks the ideal cohort calculation,
gross reward funding approaches 2 CFC and treasury accrual approaches 1 CFC per
starting ranked entrant. With treasury CFC retained, external circulation rises
by roughly the difference. If the treasury later spends its CFC, more of the
already-existing supply becomes active. If the treasury recycles CFC into the
reward vault, future minting needs fall. If it burns CFC, total supply falls.

The owner/DAO should report minting, reward-vault, treasury, burn, and circulation
figures separately rather than calling treasury custody “deflation.”

## Stablecoins and price

An approved stablecoin is another ERC-20 ante asset, not a one-for-one redemption
claim on CFC. Allowing a match to use either 1 CFC or a configured stablecoin
amount can create gameplay demand for whichever option players prefer, but it
does not establish a hard CFC floor.

A real one-dollar floor would require reliable `1 CFC -> 1 USD stablecoin`
redemption backed by adequate reserves. This policy provides no redemption,
automatic market making, price oracle, or peg.

Ranked Fibonacci eligibility gives CFC additional utility and may increase demand.
Winner sales and newly issued reward funding add supply. Market price remains an
external result of those forces and is never promised by the game.

Launch policy keeps ranked streaks CFC-only. Automatically switching the streak
asset according to a spot CFC/stablecoin price is deferred because a young,
thin market is easy to move and an abrupt threshold would change incentives.
A future owner/DAO may propose a season-boundary policy using a sustained,
reviewed price source. It must affect only new offers and cannot rewrite existing
streaks or rewards.

## Policy versions and eventual DAO control

Every funded offer stores a policy version. The owner can publish a new version,
but cannot mutate an existing version's meaning for already-created offers.
At minimum, a version identifies:

- CFC and approved ante-token addresses;
- stablecoin ante amounts and flat reward;
- ranked ante amount (fixed at 1 CFC in this policy);
- Fibonacci rule identifier;
- ranked eligibility and terminal streak rules; and
- the settlement-policy identifier used by the arena.

The initial owner can operate these contracts directly. Later, ownership can be
transferred to a DAO/timelock without migrating token balances, streaks, active
matches, or vault accounting. The DAO may vote on future issuance, reward-vault
funding, treasury improvements, approved stablecoins, or future policy versions.

DAO membership remains a later constitutional choice. A reasonable direction is
hybrid governance: CFC holders govern treasury/emissions while earned fighter or
contributor membership also approves major gameplay/protocol changes. CFC does
not promise voting rights until that separate governance policy is approved.

## Required implementation invariants

1. Only the current owner can mint, and every mint is visible through standard
   token events.
2. A match can reserve only available vault CFC; one unit cannot back two matches.
3. Owner withdrawals cannot include active escrow, reserved rewards, or player
   credits.
4. Ranked eligibility uses snapshotted equal streaks and exactly 1 CFC per player.
5. Each terminal match changes rewards, treasury, and streaks exactly once.
6. Stablecoin/unranked matches never change ranked streaks.
7. A policy change affects only offers created under the new version.
8. Pausing new activity cannot block player withdrawal or deterministic exit of
   already-funded states.
9. Ownership transfer requires explicit acceptance and can target a future DAO
   or timelock contract.
10. Arithmetic overflow or insufficient reward funding rejects offer creation;
    it never changes the promised sequence.

## Decisions required before production, not before implementation

- Initial CFC mint amount and its disclosed allocation among the reward vault,
  distribution, liquidity, and owner-controlled treasury.
- Initial approved stablecoin addresses and per-network ante amounts.
- Production network and contract addresses.
- DAO membership, proposal threshold, quorum, voting weight, and timelock delay.
- Whether a later policy recycles, spends, or burns portions of settled CFC
  treasury funds.
- Whether a later season introduces an oracle-informed stablecoin ranked mode.

These choices can be deployment parameters or later policy versions. They do not
change the launch reward sequence, exact ranked ante, eligibility, reserve rule,
or owner-to-DAO handoff architecture specified here.
