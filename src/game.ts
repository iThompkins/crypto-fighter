import type { Fighter, GameState } from "./types";

export const WIDTH = 720;
export const HEIGHT = 360;
export const FLOOR_Y = 260;
export const FPS = 30;
export const ROUND_SECONDS = 10;
export const ROUND_FRAMES = FPS * ROUND_SECONDS;

// Delay-based netcode: local input for the current sim frame is committed
// INPUT_DELAY frames in the future, so the opponent's packet (sent the same
// number of frames early) has time to arrive without stalling the sim.
// The signed packet chain reflects this: a packet for frame F acknowledges the
// opponent's packet for frame F - INPUT_DELAY. (INPUT_DELAY = 1 == old lockstep.)
export const INPUT_DELAY = 2;

export const FIGHTER_W = 28;
export const FIGHTER_H = 56;
export const MOVE_SPEED = 5;

export const ATTACK_ACTIVE_FRAMES = 4;
export const ATTACK_COOLDOWN_FRAMES = 10;
export const ATTACK_W = 18;
export const ATTACK_H = 14;
export const ATTACK_REACH = 22;
export const DAMAGE = 1;
export const MAX_HP = 7;
export const JUMP_VELOCITY = 22;
export const GRAVITY = 2;

export const INPUT = {
  LEFT: 1,
  RIGHT: 2,
  ATTACK: 4,
  UP: 8,
} as const;

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

  const midY = f.y + Math.floor(f.h / 2) - Math.floor(ATTACK_H / 2);

  if (f.facing === 1) {
    return {
      x: f.x + f.w,
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
      x: 120,
      y: FLOOR_Y - FIGHTER_H,
      w: FIGHTER_W,
      h: FIGHTER_H,
      hp: MAX_HP,
      facing: 1,
      attackCooldown: 0,
      attackActive: 0,
      vy: 0,
    },
    p2: {
      x: WIDTH - 120 - FIGHTER_W,
      y: FLOOR_Y - FIGHTER_H,
      w: FIGHTER_W,
      h: FIGHTER_H,
      hp: MAX_HP,
      facing: -1,
      attackCooldown: 0,
      attackActive: 0,
      vy: 0,
    },
  };
}

export function transition(prev: GameState, p1Mask: number, p2Mask: number): GameState {
  if (prev.roundOver) return prev;

  const s: GameState = JSON.parse(JSON.stringify(prev));
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

  s.p1.x = clamp(s.p1.x + p1Move, 0, WIDTH - s.p1.w);
  s.p2.x = clamp(s.p2.x + p2Move, 0, WIDTH - s.p2.w);

  // Vertical movement: jump + gravity (deterministic integer physics).
  const groundY = FLOOR_Y - s.p1.h;
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
    const fw = s.p1.w;
    const vOverlap = s.p1.y < s.p2.y + s.p2.h && s.p1.y + s.p1.h > s.p2.y;
    const leftIsP1 = s.p1.x <= s.p2.x;
    const left = leftIsP1 ? s.p1 : s.p2;
    const right = leftIsP1 ? s.p2 : s.p1;
    if (vOverlap && right.x < left.x + fw) {
      const center = (left.x + right.x + fw) / 2;
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

  const p1Body = { x: s.p1.x, y: s.p1.y, w: s.p1.w, h: s.p1.h };
  const p2Body = { x: s.p2.x, y: s.p2.y, w: s.p2.w, h: s.p2.h };

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
