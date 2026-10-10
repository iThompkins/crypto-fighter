import type { Fighter, GameState } from "./types";
import { ATTACK, LEFT, RIGHT, UP, isValidV1InputMask } from "./input-mask.ts";

export const SCALE = 256;
// All geometry uses integer simulation units. Convert only at the UI boundary.
export const toDisplayUnits = (value: number) => value / SCALE;
export const WIDTH = 720 * SCALE;
export const HEIGHT = 360 * SCALE;
export const FLOOR_Y = 260 * SCALE;
export const FPS = 30;
export const ROUND_SECONDS = 10;
export const ROUND_FRAMES = FPS * ROUND_SECONDS;

// Delay-based netcode: local input for the current sim frame is committed
// INPUT_DELAY frames in the future, so the opponent's packet (sent the same
// number of frames early) has time to arrive without stalling the sim.
// The signed packet chain reflects this: a packet for frame F acknowledges the
// opponent's packet for frame F - INPUT_DELAY. (INPUT_DELAY = 1 == old lockstep.)
export const INPUT_DELAY = 2;

export const FIGHTER_W = 28 * SCALE;
export const FIGHTER_H = 56 * SCALE;
export const MOVE_SPEED = 5 * SCALE;

export const ATTACK_ACTIVE_FRAMES = 4;
export const ATTACK_COOLDOWN_FRAMES = 10;
export const ATTACK_W = 18 * SCALE;
export const ATTACK_H = 14 * SCALE;
export const ATTACK_REACH = 22 * SCALE;
export const DAMAGE = 1;
export const MAX_HP = 7;
export const JUMP_VELOCITY = 22 * SCALE;
export const GRAVITY = 2 * SCALE;

export const INPUT = {
  LEFT,
  RIGHT,
  ATTACK,
  UP,
} as const;

// The collision numerator is nonnegative and bounded by 2*WIDTH.
// Nearest integer, half ties to even. Solidity equivalent: q=n/2; q+(n%2)*(q%2).
export function roundHalfToEven(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0 || n > 2 * WIDTH) throw new Error("invalid midpoint numerator");
  const q = Math.floor(n / 2);
  return q + (n % 2) * (q % 2);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function encodeInputMask(input: {
  left: boolean;
  right: boolean;
  attack: boolean;
  up?: boolean;
}) {
  let mask = 0;
  if (input.left) mask |= INPUT.LEFT;
  if (input.right) mask |= INPUT.RIGHT;
  if (input.attack) mask |= INPUT.ATTACK;
  if (input.up) mask |= INPUT.UP;
  return mask;
}

export function decodeInputMask(mask: number) {
  return {
    left: !!(mask & INPUT.LEFT),
    right: !!(mask & INPUT.RIGHT),
    attack: !!(mask & INPUT.ATTACK),
    up: !!(mask & INPUT.UP),
  };
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
) {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

export function getAttackRect(f: Fighter) {
  if (f.attackActive <= 0) return null;

  const midY = f.y + Math.floor(FIGHTER_H / 2) - Math.floor(ATTACK_H / 2);

  if (f.facing === 1) {
    return {
      x: f.x + FIGHTER_W,
      y: midY,
      w: ATTACK_W + ATTACK_REACH,
      h: ATTACK_H,
    };
  }

  return {
    x: f.x - (ATTACK_W + ATTACK_REACH),
    y: midY,
    w: ATTACK_W + ATTACK_REACH,
    h: ATTACK_H,
  };
}

export function initialState(): GameState {
  return {
    frame: 0,
    timerFramesLeft: ROUND_FRAMES,
    roundOver: false,
    winner: null,
    p1: {
      x: 120 * SCALE,
      y: FLOOR_Y - FIGHTER_H,
      hp: MAX_HP,
      facing: 1,
      attackCooldown: 0,
      attackActive: 0,
      vy: 0,
    },
    p2: {
      x: WIDTH - 120 * SCALE - FIGHTER_W,
      y: FLOOR_Y - FIGHTER_H,
      hp: MAX_HP,
      facing: -1,
      attackCooldown: 0,
      attackActive: 0,
      vy: 0,
    },
  };
}

export function transition(prev: GameState, p1Mask: number, p2Mask: number): GameState {
  assertValidState(prev);
  if (!isValidV1InputMask(p1Mask) || !isValidV1InputMask(p2Mask)) throw new Error("invalid input mask");
  if (prev.roundOver) return prev;

  const s: GameState = { ...prev, p1: { ...prev.p1 }, p2: { ...prev.p2 } };
  s.frame += 1;
  s.timerFramesLeft = Math.max(0, s.timerFramesLeft - 1);

  const p1Input = decodeInputMask(p1Mask);
  const p2Input = decodeInputMask(p2Mask);

  if (s.p1.attackCooldown > 0) s.p1.attackCooldown -= 1;
  if (s.p2.attackCooldown > 0) s.p2.attackCooldown -= 1;
  if (s.p1.attackActive > 0) s.p1.attackActive -= 1;
  if (s.p2.attackActive > 0) s.p2.attackActive -= 1;

  const p1Move = (p1Input.left ? -MOVE_SPEED : 0) + (p1Input.right ? MOVE_SPEED : 0);
  const p2Move = (p2Input.left ? -MOVE_SPEED : 0) + (p2Input.right ? MOVE_SPEED : 0);

  s.p1.x = clamp(s.p1.x + p1Move, 0, WIDTH - FIGHTER_W);
  s.p2.x = clamp(s.p2.x + p2Move, 0, WIDTH - FIGHTER_W);

  // Vertical movement: jump + gravity (deterministic integer physics).
  const groundY = FLOOR_Y - FIGHTER_H;
  if (p1Input.up && s.p1.y >= groundY) s.p1.vy = -JUMP_VELOCITY;
  if (p2Input.up && s.p2.y >= groundY) s.p2.vy = -JUMP_VELOCITY;
  s.p1.vy += GRAVITY;
  s.p2.vy += GRAVITY;
  s.p1.y += s.p1.vy;
  s.p2.y += s.p2.vy;
  if (s.p1.y >= groundY) { s.p1.y = groundY; s.p1.vy = 0; }
  if (s.p2.y >= groundY) { s.p2.y = groundY; s.p2.vy = 0; }

  // Solid bodies: fighters cannot walk through each other, but only when their
  // vertical ranges overlap (so you can jump over an opponent).
  {
    const fw = FIGHTER_W;
    const vOverlap = s.p1.y < s.p2.y + FIGHTER_H && s.p1.y + FIGHTER_H > s.p2.y;
    const leftIsP1 = s.p1.x <= s.p2.x;
    const left = leftIsP1 ? s.p1 : s.p2;
    const right = leftIsP1 ? s.p2 : s.p1;
    if (vOverlap && right.x < left.x + fw) {
      const center = roundHalfToEven(left.x + right.x + fw);
      right.x = center;
      left.x = center - fw;
      if (left.x < 0) {
        left.x = 0;
        right.x = fw;
      }
      const maxRight = WIDTH - fw;
      if (right.x > maxRight) {
        right.x = maxRight;
        left.x = maxRight - fw;
      }
    }
  }

  // Facing follows the last horizontal input (kept when standing still).
  if (p1Move > 0) s.p1.facing = 1;
  else if (p1Move < 0) s.p1.facing = -1;
  if (p2Move > 0) s.p2.facing = 1;
  else if (p2Move < 0) s.p2.facing = -1;

  if (p1Input.attack && s.p1.attackCooldown === 0 && s.p1.attackActive === 0) {
    s.p1.attackActive = ATTACK_ACTIVE_FRAMES;
    s.p1.attackCooldown = ATTACK_COOLDOWN_FRAMES;
  }

  if (p2Input.attack && s.p2.attackCooldown === 0 && s.p2.attackActive === 0) {
    s.p2.attackActive = ATTACK_ACTIVE_FRAMES;
    s.p2.attackCooldown = ATTACK_COOLDOWN_FRAMES;
  }

  const p1Attack = getAttackRect(s.p1);
  const p2Attack = getAttackRect(s.p2);

  const p1Body = { x: s.p1.x, y: s.p1.y, w: FIGHTER_W, h: FIGHTER_H };
  const p2Body = { x: s.p2.x, y: s.p2.y, w: FIGHTER_W, h: FIGHTER_H };

  const p1Hits = !!p1Attack && rectsOverlap(p1Attack, p2Body);
  const p2Hits = !!p2Attack && rectsOverlap(p2Attack, p1Body);

  if (p1Hits) s.p2.hp = Math.max(0, s.p2.hp - DAMAGE);
  if (p2Hits) s.p1.hp = Math.max(0, s.p1.hp - DAMAGE);

  if (s.p1.hp === 0 && s.p2.hp === 0) {
    s.roundOver = true;
    s.winner = "TIE_BOTH_LOSE";
  } else if (s.p1.hp === 0) {
    s.roundOver = true;
    s.winner = "P2";
  } else if (s.p2.hp === 0) {
    s.roundOver = true;
    s.winner = "P1";
  } else if (s.timerFramesLeft === 0) {
    s.roundOver = true;
    if (s.p1.hp > s.p2.hp) s.winner = "P1";
    else if (s.p2.hp > s.p1.hp) s.winner = "P2";
    else s.winner = "TIE_BOTH_LOSE";
  }

  return s;
}

// Structural/numeric domain, not a proof of reachability. Replay establishes that.
export function assertValidState(s: GameState): void {
  const keys = (v: object, expected: string[]) => {
    if (!v || typeof v !== "object" || Object.keys(v).length !== expected.length || expected.some(k => !Object.hasOwn(v, k))) throw new Error("invalid state fields");
  };
  const integer = (n: number, lo: number, hi: number) => {
    if (!Number.isSafeInteger(n) || Object.is(n, -0) || n < lo || n > hi) throw new Error("state requires bounded canonical integers");
  };
  keys(s, ["frame", "timerFramesLeft", "roundOver", "winner", "p1", "p2"]);
  integer(s.frame, 0, ROUND_FRAMES);
  integer(s.timerFramesLeft, 0, ROUND_FRAMES);
  if (s.timerFramesLeft !== ROUND_FRAMES - s.frame) throw new Error("invalid state timer");
  const fighterKeys = ["x", "y", "vy", "hp", "facing", "attackCooldown", "attackActive"];
  for (const f of [s.p1, s.p2]) {
    keys(f, fighterKeys);
    integer(f.x, 0, WIDTH - FIGHTER_W);
    integer(f.y, 94 * SCALE, FLOOR_Y - FIGHTER_H);
    integer(f.vy, -20 * SCALE, 20 * SCALE);
    if (f.y % GRAVITY !== 0 || f.vy % GRAVITY !== 0) throw new Error("invalid vertical lattice");
    integer(f.hp, 0, MAX_HP);
    integer(f.facing, -1, 1);
    if (![1, -1].includes(f.facing)) throw new Error("invalid facing");
    integer(f.attackCooldown, 0, ATTACK_COOLDOWN_FRAMES);
    integer(f.attackActive, 0, ATTACK_ACTIVE_FRAMES);
    if (f.attackActive > 0 ? f.attackCooldown !== f.attackActive + ATTACK_COOLDOWN_FRAMES - ATTACK_ACTIVE_FRAMES : f.attackCooldown > ATTACK_COOLDOWN_FRAMES - ATTACK_ACTIVE_FRAMES) throw new Error("invalid attack counters");
  }
  const terminal = s.p1.hp === 0 || s.p2.hp === 0 || s.timerFramesLeft === 0;
  const winner = !terminal ? null : s.p1.hp === s.p2.hp ? "TIE_BOTH_LOSE" : s.p1.hp > s.p2.hp ? "P1" : "P2";
  if (s.roundOver !== terminal || s.winner !== winner) throw new Error("invalid state outcome");
  if (s.frame === 0) {
    const initial = initialState();
    for (const slot of ["p1", "p2"] as const) {
      for (const key of fighterKeys as (keyof Fighter)[]) {
        if (s[slot][key] !== initial[slot][key]) throw new Error("invalid genesis state");
      }
    }
  }
}
