import { AbiCoder, id, keccak256 } from "ethers";
import * as game from "./game.ts";
import type { Fighter, GameState } from "./types.ts";

export const CANONICAL_PROTOCOL_VERSION = 2 as const;
export const CANONICAL_RULES = Object.freeze({ fps: game.FPS, roundFrames: game.ROUND_FRAMES, maxHp: game.MAX_HP, oneOutstandingPacket: true as const, inputDelay: game.INPUT_DELAY });
export const TRACE_DOMAIN = "CryptoFighter:fixed-point-trace-v2";
export const STATE_ABI_TYPES = ["bytes32", "uint16", "uint16", "bool", "uint8",
  "tuple(int32 x,int32 y,int32 vy,uint8 hp,int8 facing,uint8 attackCooldown,uint8 attackActive)",
  "tuple(int32 x,int32 y,int32 vy,uint8 hp,int8 facing,uint8 attackCooldown,uint8 attackActive)"];
const abi = AbiCoder.defaultAbiCoder();
const tag = (name: string) => id(`${TRACE_DOMAIN}:${name}`);
function fighterWords(f: Fighter): number[] {
  return [f.x, f.y, f.vy, f.hp, f.facing, f.attackCooldown, f.attackActive];
}
export function encodeTraceState(state: GameState): string {
  game.assertValidState(state);
  const outcome = { P1: 1, P2: 2, TIE_BOTH_LOSE: 3 };
  return abi.encode(STATE_ABI_TYPES, [tag("state"), state.frame, state.timerFramesLeft, state.roundOver,
    state.winner === null ? 0 : outcome[state.winner], fighterWords(state.p1), fighterWords(state.p2)]);
}
export const hashTraceState = (state: GameState) => keccak256(encodeTraceState(state));

// Commits units, midpoint ties-to-even, transition order, all constants, schema,
// and canonical genesis. Rules are compiled, never negotiated per match.
export const CANONICAL_RULES_HASH = keccak256(abi.encode(
  ["bytes32", "uint256[23]", "bytes32"],
  [tag("rules-integer-ties-even-cumulative-jump-solid-body-multihit-last-move-facing-v2"), [
    game.WIDTH, game.HEIGHT, game.FLOOR_Y, game.FPS, game.ROUND_FRAMES, game.INPUT_DELAY,
    game.FIGHTER_W, game.FIGHTER_H, game.MOVE_SPEED, game.ATTACK_ACTIVE_FRAMES,
    game.ATTACK_COOLDOWN_FRAMES, game.ATTACK_W, game.ATTACK_H, game.ATTACK_REACH,
    game.DAMAGE, game.MAX_HP, game.JUMP_VELOCITY, game.GRAVITY,
    game.INPUT.LEFT, game.INPUT.RIGHT, game.INPUT.ATTACK, game.INPUT.UP, game.SCALE,
  ], hashTraceState(game.initialState())],
));
