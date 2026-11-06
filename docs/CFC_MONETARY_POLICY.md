# CFC monetary policy and protocol-minted gameplay rewards

This document specifies the launch policy implemented by the local-only Crypto
Fighter contracts. CFC is intentionally inflationary and has no fixed supply
cap. Successful, legitimately settled games mint their deterministic rewards at
settlement. Forfeited antes belong to treasury accounting; they do not fund or
limit gameplay rewards.

Practice games remain contract-free. They use no asset, mint nothing, and cannot
change ranked streaks.

## Two separate issuance authorities

CFC exposes two independently reviewable issuance paths:

1. **Administrative issuance.** The two-step token owner may call
   `mintAdministrative` for disclosed distribution, investor, partnership,
   liquidity, or other governance-approved allocations. These mints increment
   `totalAdministrativeMinted` and emit `AdministrativeMinted`.
2. **Gameplay issuance.** Only the current gameplay authority may call
   `mintGameplayReward`. At launch that authority is the CFC credit vault, and
   only the arena operator may tell the vault to mint. These mints increment
   `totalGameplayMinted`, mark one match ID as issued, and emit both
   `GameplayRewardMinted` and `GameplayRewardCredited`.

The token owner cannot use the gameplay function after authority is handed to
the vault. Gameplay-authority changes and vault-operator changes are separate
two-step transitions. Governance can rotate those authorities, but cannot make
an existing settlement accept an arbitrary caller, recipient, or amount.

## Ranked matches

- Each ranked player escrows exactly 1 CFC.
- A ranked offer names a distinct opponent.
- Both players must have the same qualifying streak when the offer is prepared
  and remain eligible when it is joined.
- A player cannot pledge one streak into multiple unsettled ranked offers.
- The starting streak, reward, and policy version are immutable match terms.
- The winner receives their own 1 CFC ante as a player credit plus a newly
  minted Fibonacci reward.
- The loser ante becomes settled CFC treasury and the loser streak resets.
- A draw forfeits both antes to treasury but preserves both streaks.
- No established result forfeits both antes and resets both streaks.

For equal starting streak `s`, the newly minted reward is `F(s + 1)` CFC using
the positive Fibonacci sequence:

| Starting streak | Minted reward | Winner streak |
| ---: | ---: | ---: |
| 0 | 1 CFC | 1 |
| 1 | 1 CFC | 2 |
| 2 | 2 CFC | 3 |
| 3 | 3 CFC | 4 |
| 4 | 5 CFC | 5 |
| 5 | 8 CFC | 6 |
| 6 | 13 CFC | 7 |

The duplicate opening `1, 1` is intentional. There is no policy streak cap, but
the implementation uses checked `uint256` arithmetic. An offer whose Fibonacci
reward cannot be represented reverts at creation. It never wraps, truncates, or
substitutes a smaller reward.

## Unranked approved-token matches

Unranked CFC and owner-approved conventional ERC-20 matches never read or write
ranked streaks. A decisive accepted result mints a flat 1 CFC reward into the
winner's CFC player credit.

The winner's own ante is separately returned in its original token. The loser
ante enters that token's settled treasury. Approved stablecoins are ante assets,
not a CFC redemption promise, price floor, or exchange-rate guarantee.

## When gameplay issuance occurs

Gameplay issuance happens only inside the arena's exactly-once terminal
settlement operation after an accepted terminal result identifies P1 or P2 as
the winner. A claim, unverified trace, midpoint opening, isolated transition
verdict, or provisional dispute state cannot mint.

| Outcome | Ante accounting | Streak accounting | Gameplay mint |
| --- | --- | --- | ---: |
| P1 wins | P1 ante to P1 credit; P2 ante to treasury | Ranked P1 +1; P2 to 0 | Snapshotted reward to P1 credit |
| P2 wins | P1 ante to treasury; P2 ante to P2 credit | Ranked P1 to 0; P2 +1 | Snapshotted reward to P2 credit |
| Verified draw | Both antes to treasury | Preserve ranked streaks | 0 |
| No established result | Both antes to treasury | Reset ranked streaks | 0 |
| Open offer cancelled | Deposited ante returned | No streak change | 0 |
| Joined match never activated | Both antes returned | No streak change | 0 |
| Failed genesis activation | Both antes returned | No streak change | 0 |

The vault mints CFC to itself and credits the accepted winner in the same call.
If minting fails, the EVM reverts the entire settlement transaction, including
terminal state, ranked updates, escrow movement, treasury movement, and credits.

## Exactly-once and authorization boundaries

The following layers all reject replay or unauthorized issuance:

- the arena settles only an active challenge and marks it terminal once;
- the immutable match ID selects the reward record;
- the vault accepts reward instructions only from its arena operator;
- the vault credits each match ID at most once;
- the token accepts gameplay minting only from its gameplay authority; and
- the token marks each match ID as issued at most once.

The arena supplies the stored winner and stored reward amount. Peers, callers,
the token owner, and permissionless timeout executors cannot supply a reward
recipient or amount. Permissionless callers merely advance an already-defined
settlement path.

## Accounting and public observability

The following values are directly readable:

- `totalSupply`: all minted CFC not burned;
- `totalAdministrativeMinted`: cumulative discretionary issuance;
- `totalGameplayMinted`: cumulative protocol gameplay issuance;
- `totalGameplayRewardsCredited`: cumulative gameplay rewards placed in pull credits;
- `totalPlayerCredits`: CFC currently withdrawable by players;
- `totalActiveEscrow`: CFC currently committed as active antes; and
- `settledTreasury`: forfeited CFC available only to treasury governance.

`totalSupply` increases when either issuance path mints. Moving an ante to
treasury, crediting an ante back to a player, or withdrawing an existing credit
does not change supply. Direct unsolicited transfers to the vault are excess;
they do not become gameplay rewards or escrow automatically.

## Accounting examples

### Ranked starting streak 2

Both players escrow 1 CFC. The accepted winner receives a 1 CFC ante credit and
a newly minted 2 CFC reward credit, for 3 CFC of total credit. The loser's 1 CFC
ante enters treasury. Total supply rises by exactly 2 CFC.

Under the former prefunded model the same reward moved 2 existing CFC from a
reward reserve and supply did not change. That reserve no longer exists.

### Approved-token match

Both players escrow the configured approved token amount. On a decisive result,
the winner receives their approved-token ante credit, the loser ante enters that
token's treasury, and the winner receives a newly minted 1 CFC credit. CFC total
supply rises by exactly 1 CFC.

### Draw or no result

Both antes enter treasury under the existing settlement rules. No CFC reward is
minted and CFC total supply is unchanged. Ranked draws preserve streaks; ranked
no-result outcomes reset them.

## Aggregate economics

For intuition, assume fair decisive ranked outcomes, exact same-streak matching,
and a sufficiently large cohort. At level `n`, half as many players remain while
the individual reward follows Fibonacci growth. The infinite expected gross
gameplay issuance approaches 2 CFC per starting entrant. Expected forfeited ante
accrual approaches 1 CFC per starting entrant.

Those are different accounting facts. Gameplay issuance increases total supply;
treasury accrual moves already-existing CFC out of player circulation. If
treasury later withdraws and spends its CFC, that existing supply can circulate
again. A future DAO may change policies through a new explicit policy version,
but forfeited antes are not an automatic reward backing mechanism.

## Governance and market limits

Launch governance is owner-controlled and designed for later transfer to a
DAO/timelock through two-step authority handoffs. Governance may administer
discretionary issuance, treasury use, approved ante tokens, creation pause, and
future policy versions. It cannot rewrite settled results or withdraw active
escrow and player credits through the provided accounting functions.

CFC utility and ranked reward prospects may affect demand, while gameplay and
administrative issuance increase supply. This protocol makes no promise about
market value, a one-dollar floor, stablecoin convertibility, redemption, or
investment return.

## Out of scope

- Initial issuance quantity and allocation recipients.
- Investor or partnership agreements.
- Token-sale contracts, price oracles, redemption, or automatic exchange rates.
- Production-chain deployment or migration; contracts remain restricted to
  local chain ID 31337.
- General identity, anti-Sybil, or reputation systems.
