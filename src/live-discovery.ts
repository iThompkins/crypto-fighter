import { AbiCoder, id, keccak256 } from "ethers";
import { addressFromPublicKey, recoverSigner, signDigest } from "./crypto.ts";
import { hex, object } from "./live-match.ts";
import type { PlayerSlot, SessionWallet } from "./types.ts";
export type Hello = { type: "HELLO"; matchId: string; challenge: string; slot: PlayerSlot; publicKey: string; signature: string };
function digest(h: Omit<Hello, "signature">) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32", "bytes32", "uint8", "bytes"], [id("CryptoFighter.Discovery.v1"), h.matchId, h.challenge, h.slot, h.publicKey]));
}
export async function hello(wallet: SessionWallet, matchId: string, slot: PlayerSlot, challenge: string): Promise<Hello> {
  const h = { type: "HELLO" as const, matchId, challenge, slot, publicKey: wallet.publicKey };
  return { ...h, signature: await signDigest(wallet.privateKey, digest(h)) };
}
export function verifyHello(value: unknown, expectedChallenge: string): Hello {
  if (!object(value) || Object.keys(value).sort().join() !== 'challenge,matchId,publicKey,signature,slot,type' || value.type !== "HELLO" || !hex(value.matchId, 32) || !hex(value.challenge, 32) || !hex(value.publicKey, 65) || !hex(value.signature, 65) || (value.slot !== 1 && value.slot !== 2)) throw new Error("Invalid discovery schema");
  const h = value as Hello;
  if (h.challenge !== expectedChallenge) throw new Error("Stale discovery challenge");
  if (recoverSigner(digest(h), h.signature).toLowerCase() !== addressFromPublicKey(h.publicKey)) throw new Error("Invalid discovery signature");
  return structuredClone(h);
}
