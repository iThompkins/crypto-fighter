# Reachable horizontal numeric domain

Analysis of the unchanged `src/game.ts` transition, 2026-09-17. No gameplay,
trace serialization, hash domain, canonical fingerprint or settlement behavior
is changed by this analysis. The test oracle is analysis-only code.

## Result

Every horizontal position stored in a reachable `GameState` is in `[0, 692]`
and is an integer multiple of **2^-48**. This bound is tight: a legal sequence
reaches an odd numerator over 2^48 for both players at frame 203, with seven HP
each, and can retain those positions through a terminal tie at frame 300.

This is a bound on the reachable set, not a claim that every point on that grid
is reachable. It establishes the exact largest required dyadic denominator;
it does not enumerate every reachable position/state combination.

An exact integer state representation therefore exists: `X = x * 2^48`, with
`0 <= X <= 692 * 2^48 < 2^58`. It fits comfortably in existing Solidity integer
word widths. This does **not** authorize a trace-format change, or imply that
unrounded integer transition arithmetic would preserve current gameplay.

## Precision evolution

The native simulator uses JavaScript binary64 `number`, not fixed-point integers.
Initial x coordinates are 120 and 572; both fighter widths remain 28.
Only the two stored x fields acquire fractional values. Vertical position and
velocity remain integer-valued under the compiled jump/gravity rules.

1. **Movement:** adding -5, 0 or 5 cannot increase dyadic precision in exact
   arithmetic. Binary64 rounding can discard low bits, but preserves an existing
   power-of-two grid. If its spacing is finer than the grid, the exact sum is
   representable; otherwise rounding lands on a coarser grid.
2. **Independent movement clamping:** a fighter crossing a wall is assigned 0 or
   692. This removes that fighter's fractional part without changing the other's.
   It can therefore destroy equality of the two fractional parts.
3. **No overlapping bodies:** there is no further x arithmetic. Jumping can
   suppress a body collision, but cannot itself introduce horizontal fractions.
4. **Overlapping bodies:** with `a` the left x and `b` the right x, JavaScript
   evaluates `center = fl(fl(a + b) + 28) / 2`, where `fl` denotes rounding to
   binary64 after that individual operation. Then `right.x = center` and
   `left.x = fl(center - 28)`. Both assignments modify authoritative state.
5. **Joint collision boundary correction:** an out-of-stage collision result
   assigns `(0, 28)` or `(664, 692)` to the ordered pair, removing fractions.

In ideal exact arithmetic, write `a=A/2^k` and `b=B/2^k`. The collision center is
`(A+B+28*2^k)/2^(k+1)`. An odd numerator introduces one extra fractional bit.
For k>=1, equal fractional parts make A and B have equal parity, so this does not
increase the maximum precision. Independent clamping allows unequal parity.
Repeated clamp-and-recollision cycles can repeatedly add a bit. There is no
invariant limiting the game to halves, quarters, eighths or sixteenths.

## Tight reachable witness

Masks 1 and 2 mean left and right; mask 0 means idle. Start from `initialState()`:

| Inputs | Resulting frame | P1.x | P2.x |
| --- | ---: | ---: | ---: |
| 108 frames `(1,1)` | 108 | 0 | 32 |
| One frame `(2,0)` | 109 | 4.5 | 32.5 |
| `(1,0)`, then `(2,0)` | 111 | 4.75 | 32.75 |
| Repeat that pair | 113 | 4.875 | 32.875 |
| Repeat that pair | 115 | 4.9375 | 32.9375 |
| Continue to 46 pairs after frame 109 | 201 | 5 - 2^-47 | 33 - 2^-47 |
| One frame `(1,0)` | 202 | 0 | 33 - 2^-47 |
| One frame `(2,1)` | 203 | 2.5 - 2^-48 | 30.5 - 2^-48 |

Why the two-frame cycle works: from `(a, a+28)` with `0<a<5`, move only P1 left.
P1 clamps to zero; P2 stays beyond 28, so there is no collision. Next move only
P1 right to 5. The bodies overlap and the new left position in exact arithmetic
is `(a+5)/2`. Starting with a=4.5, this gives `a=5-2^-k` at frame `107+2k`.
Native arithmetic reproduces it exactly for k=1 through 47.

At frame 203, after movement the ordered coordinates are5 and `28-2^-47`.
The collision numerator is `61-2^-47`, which is exactly representable. Halving
and subtracting28 produce the stated positions. Their scale 2^48 integers are:

- P1: `703687441776639` (odd).
- P2: `8584986789675007` (odd).

Thus 48 fractional bits are necessary, not merely a conservative sufficient bound.
Idle inputs through frame 300 leave these coordinates unchanged and produce the
normal equal-HP terminal tie. Calling `transition` after terminality returns the
same state, so there is no post-terminal precision growth.

## Universal upper-bound proof, including floating-point rounding

Induct over calls to the native transition from the canonical initial state.
Assume both stored x coordinates are multiples of 2^-48 in `[0,692]`.
Movement, clamping, and absence of collision preserve that property as described
above. For a collision, let `T = fl(fl(a+b)+28)` and `C=T/2`.

- If C < 28, `C-28` is negative and the subsequent left-wall collision correction
  sets the ordered pair to `(0,28)`. A transient midpoint may require a 49th
  fractional bit, but those values do not survive into the returned state.
- Otherwise T >= 56. Binary64 numbers at or above 56 have spacing at least2^-47
  (56 lies in the binade `[32,64)`, with spacing2^(5-52)). Therefore the rounded
  T is a multiple of2^-47. Division by 2 is exact in this normal finite range,
  and C is a multiple of 2^-48. Subtraction of integer 28 and any rounding preserve
  that grid. If the right boundary is exceeded, correction assigns integers.

No other transition operation writes the x fields. These cases establish the
invariant for all reachable states, including every possible input sequence,
vertical overlap pattern, attack outcome and the full 300-frame horizon. Early
KO only stops advancement sooner. The lattice proof itself does not depend on
300: binary64 and these movement/collision constants impose the bound.

In an ideal unrounded rational version of the arithmetic, the two-frame cycle
would keep adding fractional bits indefinitely if the timer were removed. The
**actual simulator cannot generate unboundedly finer stored fractions**. It
both stops at 300 and has the stronger binary64 lattice bound just proved.

## Integer encoding versus integer execution

Encoding each native position as the integer X = x * 2^48 can preserve it exactly.
These integers can exceed `Number.MAX_SAFE_INTEGER`; use exact integer handling
for any proposed codec. Multiplication of an existing native position by this
power of two is exact and finite here, so converting that resulting integral
Number to BigInt retains its represented integer. Do not subsequently compute
scaled arithmetic with ordinary Number integers above the safe-integer bound.

An exact state representation is only half of the transition problem. A naive
fixed-point implementation that adds exact integers and halves the result can
produce a different state from JavaScript's ordered floating-point operations.
For example, continue the ordinary cycle from frame 201 with `(1,0),(2,0)`:

- Unrounded rational arithmetic predicts `(5-2^-48,33-2^-48)` at 203.
- Native JavaScript rounds the numerator `66-2^-47` to 66 (nearest, ties-to-even),
  then divides by 2, producing exactly `(5,33)`.

The analysis test implements a BigInt oracle with binary64 rounding after each
addition, including the separate `a+b` and `+28` operations. It also rounds the
collision overlap expression `a+28`. It matches the native transition without
changing gameplay. This demonstrates a feasible integer implementation path;
it is not a Solidity verifier or a selected/approved protocol representation.

## Validation and its limits

`test/horizontal-numeric-domain.test.mjs` checks:

- Every fractional precision from 1 through 47 along the reachable cycle and the
  tight 48-bit witness, followed through the 300-frame terminal state.
- The explicit rounding divergence from unrounded rational averaging.
- All 256 pairs of input masks at ten reachable precision-boundary states.
- Four depth-4 exhaustive motion searches from reachable states, including the
  47- and 48-bit positions. Six distinct movement/jump actions cover all mask
  geometry; attacks are omitted in these searches, so no KO truncates a branch.
  States are merged only by the x/y/vy fields determining future geometry.
- 64 seeded full matches with jumps, attack masks, wall movement and terminal
  absorption. Every tested step checks bounds, exact lattice membership, exact
  integer round-trip and equality with the BigInt rounding oracle.

The bounded searches and properties support the analysis; they are not an
exhaustive enumeration of all 256^300 input histories. The universal claim rests
on the inductive proof, and tightness on the concrete canonical witness.
