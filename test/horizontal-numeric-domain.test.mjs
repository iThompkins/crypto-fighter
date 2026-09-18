import assert from "node:assert/strict";
import test from "node:test";
import { initialState, transition } from "./fixtures/legacy-binary64.mjs";

// Analysis-only integers; neither the simulation nor the trace codec uses this
// representation. See docs/HORIZONTAL_NUMERIC_DOMAIN.md for the universal proof.
const SCALE = 1n << 48n;
const units = (n) => BigInt(n) * SCALE;
const scaled = (x) => {
  assert.ok(Number.isInteger(x * 2 ** 48), `off-grid position ${x}`);
  return BigInt(x * 2 ** 48); // Multiplication by a power of two is exact here.
};
function assertDomain(s) {
  for (const f of [s.p1, s.p2]) {
    assert.ok(f.x >= 0 && f.x <= 692);
    const n = scaled(f.x);
    assert.ok(n >= 0n && n <= units(692) && n < (1n << 58n));
    // These integers can exceed Number.MAX_SAFE_INTEGER, but as scaled native
    // binary64 values their significant bits fit and this round trip is exact.
    assert.equal(Number(n) / 2 ** 48, f.x);
  }
}
function fractionalBits(x) {
  let n = scaled(x), bits = 48;
  if (n === 0n) return 0;
  while (bits > 0 && n % 2n === 0n) { n /= 2n; bits--; }
  return bits;
}
// Exact integer reference for IEEE binary64 round-to-nearest, ties-to-even.
// The common power-of-two scale does not change the significant-bit count.
function roundBinary64(n) {
  const sign = n < 0n ? -1n : 1n;
  n *= sign;
  const shift = n.toString(2).length - 53;
  if (shift <= 0) return sign * n;
  const shiftBits = BigInt(shift), quantum = 1n << shiftBits;
  let q = n >> shiftBits;
  const remainder = n % quantum, half = quantum / 2n;
  if (remainder > half || (remainder === half && q % 2n === 1n)) q++;
  return sign * q * quantum;
}
const add = (a, b) => roundBinary64(a + b);
const clamp = (n, min, max) => n < min ? min : n > max ? max : n;
function movedFighter(f, mask) {
  const dx = (mask & 1 ? -5 : 0) + (mask & 2 ? 5 : 0);
  const x = clamp(add(scaled(f.x), units(dx)), 0n, units(692));
  let vy = mask & 8 && f.y >= 204 ? -22 : f.vy;
  vy += 2;
  let y = f.y + vy;
  if (y >= 204) { y = 204; vy = 0; }
  return { x, y, vy };
}
function integerGeometry(s, a, b) {
  if (s.roundOver) return [scaled(s.p1.x), scaled(s.p2.x)];
  const p1 = movedFighter(s.p1, a), p2 = movedFighter(s.p2, b);
  const [left, right] = p1.x <= p2.x ? [p1, p2] : [p2, p1];
  if (p1.y < p2.y + 56 && p1.y + 56 > p2.y && right.x < add(left.x, units(28))) {
    // Parenthesization matters: JS rounds each addition, not just the sum.
    const numerator = add(add(left.x, right.x), units(28));
    if (numerator < units(56)) {
      // A transient center below28 may need49 fraction bits; both stored x
      // positions are immediately replaced by the left-wall correction.
      left.x = 0n; right.x = units(28);
    } else {
      assert.equal(numerator % 2n, 0n);
      right.x = numerator / 2n;
      left.x = add(right.x, -units(28));
      if (right.x > units(692)) { right.x = units(692); left.x = units(664); }
    }
  }
  return [p1.x, p2.x];
}
function checkedStep(s, a, b) {
  const expected = integerGeometry(s, a, b);
  const next = transition(s, a, b);
  assertDomain(next);
  assert.deepEqual([scaled(next.p1.x), scaled(next.p2.x)], expected);
  return next;
}
function precisionWitness() {
  let s = initialState();
  const states = new Map([[0, s]]);
  const step = (a, b) => { s = checkedStep(s, a, b); states.set(s.frame, s); };
  for (let i = 0; i < 108; i++) step(1, 1);
  step(2, 0);
  for (let i = 0; i < 46; i++) { step(1, 0); step(2, 0); }
  step(1, 0); step(2, 1);
  return states;
}

test("reachable collision cycles attain every precision from halves through 2^-48 within 203 frames", () => {
  const states = precisionWitness();
  assert.deepEqual([states.get(108).p1.x, states.get(108).p2.x], [0, 32]);
  for (let k = 1; k <= 47; k++) {
    const s = states.get(107 + 2 * k);
    assert.equal(s.p1.x, 5 - 2 ** -k);
    assert.equal(s.p2.x, 33 - 2 ** -k);
    assert.equal(fractionalBits(s.p1.x), k);
  }
  let s = states.get(203);
  assert.equal(s.p1.x, 2.5 - 2 ** -48);
  assert.equal(s.p2.x, 30.5 - 2 ** -48);
  assert.equal(scaled(s.p1.x), 703687441776639n);
  assert.equal(scaled(s.p2.x), 8584986789675007n);
  assert.equal(fractionalBits(s.p1.x), 48);
  assert.equal(fractionalBits(s.p2.x), 48);
  while (!s.roundOver) s = checkedStep(s, 0, 0);
  assert.equal(s.frame, 300);
  assert.equal(s.winner, "TIE_BOTH_LOSE");
  assert.equal(fractionalBits(s.p1.x), 48);
  assert.deepEqual([s.p1.hp, s.p2.hp], [7, 7]);
});

test("native rounding prevents unbounded refinement and differs from unrounded rational averaging", () => {
  const states = precisionWitness();
  let s = checkedStep(states.get(201), 1, 0);
  s = checkedStep(s, 2, 0);
  // The rational recurrence would give 5-2^-48,33-2^-48 here, but its
  // numerator66-2^-47 rounds to66 before division in the native game.
  assert.deepEqual([s.p1.x, s.p2.x], [5, 33]);
  assert.notEqual(s.p1.x, 5 - 2 ** -48);
  assert.equal(roundBinary64(units(66) - 2n), units(66));
});

test("all 256 mask pairs match the exact integer rounding oracle at reachable precision boundaries", () => {
  const states = precisionWitness();
  for (const frame of [0, 108, 109, 110, 111, 199, 200, 201, 202, 203]) {
    for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) checkedStep(states.get(frame), a, b);
  }
});

test("bounded exhaustive reachable motion branches preserve the lattice and native arithmetic", (t) => {
  const states = precisionWitness();
  // Six distinct horizontal/jump actions cover all mask geometry. Attack/facing
  // do not feed movement; this search uses no attacks so it never truncates a
  // branch through KO. This is bounded exploration, not exhaustive300-frame play.
  const actions = [0, 1, 2, 8, 9, 10];
  const key = (s) => [s.p1.x, s.p1.y, s.p1.vy, s.p2.x, s.p2.y, s.p2.vy].join(",");
  let checked = 0;
  for (const frame of [0, 109, 201, 203]) {
    let frontier = new Map([[key(states.get(frame)), states.get(frame)]]);
    for (let depth = 0; depth < 4; depth++) {
      const next = new Map();
      for (const s of frontier.values()) for (const a of actions) for (const b of actions) {
        const child = checkedStep(s, a, b);
        next.set(key(child), child);
        checked++;
      }
      frontier = next;
    }
  }
  t.diagnostic(`Exhaustively checked ${checked} transitions across four depth-4 motion searches.`);
  assert.ok(checked > 10000);
});

test("seeded full-match input properties cover jumps, attacks, wall motion and terminal absorption", (t) => {
  let seed = 0x3a142857, checked = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let run = 0; run < 64; run++) {
    let s = initialState(), a = 0, b = 0;
    for (let frame = 1; frame <= 300; frame++) {
      if (frame % 17 === 1) { a = random() >>> 28; b = random() >>> 28; }
      s = checkedStep(s, a, b);
      checked++;
      if (s.roundOver) { assert.deepEqual(checkedStep(s, 15, 15), s); break; }
    }
    assert.equal(s.roundOver, true);
  }
  t.diagnostic(`Checked ${checked} transitions across 64 seeded complete matches.`);
});
