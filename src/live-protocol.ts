import { AbiCoder, id, keccak256 } from "ethers";
import { addressFromPublicKey, recoverSigner, ZERO32 } from "./crypto.ts";
import { INPUT_DELAY, ROUND_FRAMES } from "./game.ts";
import { hashGenesisBinding, type GenesisAuthorization } from "./genesis.ts";
import { CANONICAL_RULES_HASH } from "./protocol.ts";
import { isValidV1InputMask } from "./input-mask.ts";
import type { PlayerSlot, SignedInputPacket } from "./types.ts";

export type LiveConfig = { version: 1; mode: "practice" | "escrow"; matchId: string; rulesHash: string;
  p1PublicKey: string; p2PublicKey: string; authorization?: GenesisAuthorization };
export type Ready = { type: "READY"; context: string; slot: PlayerSlot; signature: string };
export type LiveMessage = Ready | { type: "INPUT"; context: string; packet: SignedInputPacket }
  | { type: "REQUEST"; context: string; slot: PlayerSlot; frame: number; signature: string };
const abi = AbiCoder.defaultAbiCoder();
export const hex = (v: unknown, n: number): v is string => typeof v === "string" && new RegExp(`^0x[0-9a-fA-F]{${n * 2}}$`).test(v);
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function exact(v: Record<string, unknown>, fields: string[]) { return Object.keys(v).sort().join() === fields.sort().join(); }
export function configHash(value: unknown): string {
  if (!object(value) || !exact(value, ["version", "mode", "matchId", "rulesHash", "p1PublicKey", "p2PublicKey", ...(value.mode === "escrow" ? ["authorization"] : [])]) ||
    value.version !== 1 || !["practice", "escrow"].includes(String(value.mode)) || !hex(value.matchId, 32) || value.matchId === ZERO32 || value.rulesHash !== CANONICAL_RULES_HASH || !hex(value.p1PublicKey, 65) || !hex(value.p2PublicKey, 65)) throw new Error("Invalid match descriptor");
  const p1 = addressFromPublicKey(value.p1PublicKey), p2 = addressFromPublicKey(value.p2PublicKey);
  if (p1 === p2) throw new Error("Distinct session identities required");
  const c = value as LiveConfig;
  let bindingHash = ZERO32;
  if (c.mode === "escrow") {
    if (!object(c.authorization) || !exact(c.authorization, ["binding", "p1Signature", "p2Signature"]) || !hex(c.authorization.p1Signature, 65) || !hex(c.authorization.p2Signature, 65) || !object(c.authorization.binding) ||
      !exact(c.authorization.binding, ["chainId", "arena", "challengeId", "genesis", "rulesHash", "p1", "p2", "p1Session", "p2Session", "stake", "responseWindow", "restrictedOpponent"])) throw new Error("Invalid authorization schema");
    if (!c.authorization || c.authorization.binding.genesis !== c.matchId || c.authorization.binding.p1Session.toLowerCase() !== p1 || c.authorization.binding.p2Session.toLowerCase() !== p2) throw new Error("Descriptor delegation mismatch");
    bindingHash = hashGenesisBinding(c.authorization.binding);
  }
  return keccak256(abi.encode(["bytes32", "bytes32", "bytes32", "address", "address", "bytes32"],
    [id(`CryptoFighter.Live.${c.mode}.v1`), c.matchId, c.rulesHash, p1, p2, bindingHash]));
}
export function lifecycleDigest(context: string, slot: PlayerSlot, action: "READY" | "REQUEST", frame = 0) {
  return keccak256(abi.encode(["bytes32", "bytes32", "uint8", "uint16"], [id(`CryptoFighter.Live.${action}.v1`), context, slot, frame]));
}
export function parseLiveMessage(value: unknown): LiveMessage {
  if (!object(value) || !hex(value.context, 32)) throw new Error("Invalid live envelope");
  if (value.type === "INPUT") {
    if (!exact(value, ["type", "context", "packet"]) || !object(value.packet) || !exact(value.packet, ["matchId", "frame", "player", "inputMask", "prevSelfHash", "prevOppHash", "publicKey", "signature", "hash"])) throw new Error("Invalid input envelope");
    const p = value.packet;
    if (!hex(p.matchId, 32) || !hex(p.hash, 32) || !hex(p.prevSelfHash, 32) || !hex(p.prevOppHash, 32) || !hex(p.publicKey, 65) || !hex(p.signature, 65) || (p.player !== 1 && p.player !== 2) || !Number.isSafeInteger(p.frame) || Number(p.frame) < 1 || Number(p.frame) > ROUND_FRAMES + INPUT_DELAY || !isValidV1InputMask(p.inputMask)) throw new Error("Invalid input schema");
  } else if ((value.type !== "READY" && value.type !== "REQUEST") || !exact(value, ["type", "context", "slot", "signature", ...(value.type === "REQUEST" ? ["frame"] : [])]) ||
    (value.slot !== 1 && value.slot !== 2) || !hex(value.signature, 65) || (value.type === "REQUEST" && (!Number.isSafeInteger(value.frame) || Number(value.frame) < 1 || Number(value.frame) > ROUND_FRAMES + INPUT_DELAY))) throw new Error("Invalid lifecycle schema");
  return structuredClone(value) as LiveMessage;
}
export function verifyReady(config: LiveConfig, value: unknown, slot: PlayerSlot): Ready {
  const message = parseLiveMessage(value);
  const context = configHash(config);
  if (message.type !== "READY" || message.context !== context || message.slot !== slot ||
    recoverSigner(lifecycleDigest(context, slot, "READY"), message.signature).toLowerCase() !== addressFromPublicKey(slot === 1 ? config.p1PublicKey : config.p2PublicKey)) throw new Error("Invalid offer readiness");
  return message;
}
