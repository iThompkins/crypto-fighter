# Canonical fixed-point protocol v2 — Phase A

Approved scope: numeric protocol, simulation, state codec, versions/fingerprint,
reference vectors, transcript verification/generation, and rendering conversion.
No one-step adjudication or payout/recovery entry point is added. Browser
settlement and nonlocal deployment remain disabled. Existing Merkle/bisection
algorithms are retained; their format tags and contract state codec are migrated
only so they continue to consume the canonical state.

## Numeric contract

`SCALE = 256`. All geometry, positions and velocities are integer simulation units;
one displayed game unit is 256 simulation units. HP, facing, frames and attack
counters are unscaled. Body dimensions are compiled constants, not state fields.

| Quantity | Integer value |
|---|---:|
| Stage width/height | 184320 / 92160 |
| Floor | 66560 |
| Body width/height | 7168 / 14336 |
| Movement | 1280 per frame |
| Jump initialization / gravity | -5632 / +512 per frame |
| Attack width including reach / height | 10240 / 3584 |
| Initial x positions | 30720 / 146432 |
| Initial y positions | 52224 / 52224 |

TypeScript uses validated integer `number`s. No authoritative operation produces
an unquantized fractional result. The half operation is explicit below. Values
and intermediates are far below 2^53. There is no binary64 compatibility layer.
Rendering alone divides by 256; CSS scaling never feeds back into physics.

The codec uses int32 for x/y/vy, uint16 for frame/timer, uint8 for HP/counters,
and int8 for facing. Future Solidity transition arithmetic must widen to int256
before addition/subtraction and validate before narrowing. Short ABI fields do
not imply packed calldata or lower gas.

### Reachable bounds and validation

- x: [0,177152].
- y: [24064,52224], a multiple of 512.
- vy: conservatively [-5120,5120], a multiple of 512.
- frame: [0,300]; timer = 300 - frame.
- HP: [0,7]; facing exactly -1 or +1.
- attack active: [0,4]; cooldown: [0,10]. While active, cooldown = active+6;
  otherwise cooldown <=6.
- Terminal iff either HP is zero or timer is zero. Outcome is then the higher-HP
  side or tie; pending otherwise. This equals the specified KO-before-timer rule.
- Frame zero is exactly canonical genesis.

`assertValidState` validates these bounds, integer/negative-zero rules, exact
field sets and terminal consistency. It is not a proof of reachability: arbitrary
combinations inside these bounds need not be reachable. Only replay from genesis
establishes reachability. The future step verifier must respect that distinction.
The TypeScript transition validates its pre-state and both input masks.

## Midpoint alternatives and decision

Let L/R be ordered x coordinates after movement/clamping, W the body width,
N=L+R+W, and S the integer stage width. N is nonnegative and <2*S.

| Rule | Formula / tie | Consequence |
|---|---|---|
| Floor | floor(N/2) | Odd numerators always shift the pair left by 1/512 game unit. |
| Nearest, ties upward | floor((N+1)/2) | Same magnitude, always right on odd numerators. |
| Nearest, ties to even | q=floor(N/2); q+(N mod 2)*(q mod 2) | Rounds to even on halves; respects reflection across this stage. |

Chosen: **nearest, ties to even**. Both possible candidates are equally near when
N is odd. Choosing parity requires no history, slot preference, random seed or
additional state. It costs two parity operations and an addition beyond the
integer division; no gas-saving claim has been measured.

For reflected ordered coordinates, N' = 2*S-N. Since S=184320 is even,
roundEven(N'/2)=S-roundEven(N/2). Floor violates this identity on every odd N.
A changed stage width must preserve this condition or revisit the rule.
This is a symmetry guarantee, not a statistical promise about arbitrary inputs.
The maximum local midpoint rounding error is 0.5 simulation units = 1/512 game
unit. No universal whole-match trajectory bound follows from this local bound.

TypeScript: `q = Math.floor(N / 2); C = q + (N % 2) * (q % 2)`.
Solidity for validated nonnegative N: `q=N/2; C=q+(N%2)*(q%2)`.
Negative division is not used. New physics involving negative division requires
its own explicit rounding specification.

Set right.x=C and left.x=C-W, then jointly correct walls to (0,W) or
(S-2*W,S-W). Vertical and horizontal overlap remain strict inequalities. Facing,
attack activation/damage, timer and KO ordering are unchanged.

Equal x still assigns P1 to the left, as in the development game. This is an
existing slot tie-break, not midpoint-rounding bias. Reflection plus swapping
player slots, facing, outcomes and horizontal inputs is exactly symmetric,
including equal x. Reflection retaining slots is not symmetric at exact ties.
We retain that gameplay rule rather than bundle a new body-order policy into
Phase A. This does not claim complete game balance or eliminate all slot effects.

## State bytes and versions

Canonical ABI (`abi.encode`, not packed), in this order:

```
bytes32 stateTag
uint16 frame
uint16 timerFramesLeft
bool roundOver
uint8 outcome
(int32 x,int32 y,int32 vy,uint8 hp,int8 facing,uint8 attackCooldown,uint8 attackActive) p1
(int32 x,int32 y,int32 vy,uint8 hp,int8 facing,uint8 attackCooldown,uint8 attackActive) p2
```

Outcome: 0 pending, 1 P1, 2 P2, 3 tie. Every scalar occupies a 32-byte ABI word;
there are 19 words (608 bytes). Signed negatives are sign-extended. No optional
fields, implicit unit conversion, rounding during encoding, JSON key-order
semantics or alternate packed encoding exists. JSON carries parsed integer
values; canonical bytes, not lexical JSON spelling, define the hash.

`stateTag = keccak256(UTF8("CryptoFighter:fixed-point-trace-v2:state"))`.
`stateHash = keccak256(encodedState)`, shared by transcript final records and
trace checkpoints. The removed JSON-state hash is not accepted as an alternative.

- Canonical protocol/transcript version: 2.
- Transcript requires the canonical `rulesHash` plus exact descriptive metadata.
- Diagnostic format: `fixed-point-trace-v2`.
- Authorized format: `genesis-authorized-trace-v2`.
- All trace domains use `CryptoFighter:fixed-point-trace-v2:<suffix>`.
- Fingerprint: `0x45e7b6011925954ee1b15160173864f8deea010e005bd0c4dfca5fbc1d503a18`.

The fingerprint commits the semantic revision (including ties-even and transition
order), all 23 numeric entries including scale, and canonical encoded genesis.
Old transcripts, fingerprints, genesis state hashes and trace roots are rejected,
not relabeled. Input mask v1 remains 0..15; packet/frame digest formats and genesis
binding/authorization v1 schemas remain unchanged. The new rules hash carries the
new numeric protocol into an authorized genesis. New matches need fresh context;
old signatures are not a migration mechanism. A bare practice transcript's rules
hash is metadata checked by replay, not escrow authority.

## Evidence and behavioral differences

Test-only `fixtures/legacy-binary64.mjs` freezes the old simulator from 32079a3.
The old numeric-domain tests now explicitly target that historical snapshot.
No production module or verifier imports it or supports old replay versions.
The generator now calls the shared current simulation rather than duplicate physics.

The independent BigInt reference uses a different collision expression and manual
ABI word encoding. Thirteen checked-in transition/state vectors cover midpoint
parities, walls, equal x, airborne separation, simultaneous KO, timer ties, exact
attack edges, signed velocity and terminal absorption. The vector generator is
explicit and is not invoked by the tests. A test-only, in-memory Solidity harness
checks midpoint arithmetic; the existing contract codec checks state hash vectors.
This is not a Solidity one-step verifier.

Fixed-point tests exhaust all 368641 midpoint numerators in [0,2*S], checking
reflection, tie parity and local error, plus all 256 mask pairs over seven
boundary states, mirrored transitions and 64 complete seeded BigInt comparisons.
The former authenticated quarter-unit transcript now builds both diagnostic and
authorized commitments successfully. Browser tests check actual fighter/attack
CSS geometry and complete browser/CLI replay parity.

A reproducible old/new comparison uses 128 matches with seed 0x12345678:
64 random-mask matches, then 64 matches prefixed with deliberate wall/recollision
cycles through frame 160 followed by random masks. Results:

- 31907 compared transitions with both pre-states still active.
- Maximum horizontal difference in that sample: 1/512 game unit.
- Ordinary movement, jump, idle and approach/attack scenarios match exactly after
  scaling; all 64 unprefixed random matches had unchanged terminal results.
- Stress match 71: P1 wins at frame 300 instead of frame 203.
- Stress match 73: P1 wins at frame 216 instead of frame 197.
- Stress match 94: P2 wins the timer comparison instead of P1.

These three cases differ at strict hit boundaries following quantized wall cycles.
An old infinitesimal overlap can become an exact edge, and strict overlap then
correctly reports no hit under v2. A one-hit difference can alter later HP and
terminal outcomes. Comparing frozen old terminal states against a still-running
new match also produces large apparent position differences; those are different
termination times, not large midpoint errors.

These are characterization results, not a universal compatibility, visual quality,
balance or gas guarantee. Human gameplay feel remains a playtest judgment. No
changes to intended speed, jump trajectory, attack timing/damage, timer length,
simultaneous-hit processing, or tie policy were introduced.

## Phase boundary

This phase migrates the state codec in existing contracts and updates versioned
trace consumers solely for consistency. It does not add transitions, dispute
resolution, replacement claims, timeouts, recovery, or payout authority. Existing
trace claims still have no payout/recovery path; all settlement containment stays
in place. Phase B and later work remains as laid out in the approved roadmap.

## Exit validation

`CHROMIUM_PATH=/usr/bin/chromium npm run check` passed on 2026-09-17:
lint, 73 Node tests, production build, 43 local contract tests, and two real-browser
tests. The existing bundle-size warning remains. This validates Phase A's automated
exit criteria; it does not establish payout security or replace human playtesting.
