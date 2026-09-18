import { AbiCoder, id, keccak256 } from "ethers";
import * as game from "./game.ts";
import type { Fighter, GameState } from "./types.ts";

// One canonical game version. These constants are not match options.
export const CANONICAL_PROTOCOL_VERSION = 1 as const;
export const CANONICAL_V1_RULES = Object.freeze({ fps: game.FPS, roundFrames: game.ROUND_FRAMES, maxHp: game.MAX_HP, oneOutstandingPacket: true as const, inputDelay: game.INPUT_DELAY });
const abi = AbiCoder.defaultAbiCoder();
const digest = (types: string[], values: unknown[]) => keccak256(abi.encode(types, values));
// Preserve the published experimental fingerprint/encoding byte-for-byte.
const tag = (name: string) => id(`CryptoFighter:experimental-offchain-trace-v1:${name}`);

// Explicit semantic revision plus every current numeric rule. Changing transition
// order/semantics requires a new revision even if its numeric constants stay equal.
export const CANONICAL_RULES_HASH = digest(
  ["bytes32", "uint256[23]", "bytes32"],
  [tag("rules-cumulative-jump-solid-body-multihit-last-move-facing-v1"), [
    game.WIDTH, game.HEIGHT, game.FLOOR_Y, game.FPS, game.ROUND_FRAMES, game.INPUT_DELAY,
    game.FIGHTER_W, game.FIGHTER_H, game.MOVE_SPEED, game.ATTACK_ACTIVE_FRAMES,
    game.ATTACK_COOLDOWN_FRAMES, game.ATTACK_W, game.ATTACK_H, game.ATTACK_REACH,
    game.DAMAGE, game.MAX_HP, game.JUMP_VELOCITY, game.GRAVITY,
    game.INPUT.LEFT, game.INPUT.RIGHT, game.INPUT.ATTACK, game.INPUT.UP, 2,
  ], keccak256(encodeTraceState(game.initialState()))],
);

function integer(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("state requires exact safe integers in scaled encoding");
  return value;
}
function fighterWords(f: Fighter): number[] {
  // Existing codec preserves half-units only. Reachable quarter-unit geometry
  // is a known blocker: test/trace-geometry-blocker.test.mjs. Never round it.
  return [f.x * 2, f.y * 2, f.w * 2, f.h * 2, f.hp, f.facing, f.attackCooldown, f.attackActive, f.vy * 2].map(integer);
}
export function encodeTraceState(state: GameState): string {
  const outcome = { P1: 1, P2: 2, TIE_BOTH_LOSE: 3 };
  if (typeof state.roundOver !== "boolean" || (state.winner !== null && !(state.winner in outcome))) throw new Error("invalid state outcome");
  return abi.encode(
    ["bytes32", "uint256", "uint256", "bool", "uint8", "int256[9]", "int256[9]"],
    [tag("state"), integer(state.frame), integer(state.timerFramesLeft), state.roundOver,
      state.winner === null ? 0 : outcome[state.winner], fighterWords(state.p1), fighterWords(state.p2)],
  );
}
export const hashTraceState = (state: GameState) => keccak256(encodeTraceState(state));

