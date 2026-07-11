import * as secp from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";
import { hmac } from "@noble/hashes/hmac";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { PlayerSlot, SessionWallet, SignedInputPacket } from "./types";

// Wire secp256k1's HMAC to pure-JS so signing works in non-secure contexts too
// (e.g. the app served over plain http from a VM by IP, where crypto.subtle is
// unavailable). Without this, signAsync can fail outside https/localhost.
secp.etc.hmacSha256Sync = (key, ...msgs) => hmac(sha256, key, secp.etc.concatBytes(...msgs));
secp.etc.hmacSha256Async = async (key, ...msgs) => hmac(sha256, key, secp.etc.concatBytes(...msgs));

// 32-byte zero sentinel used to seed the packet/frame hash chains.
export const ZERO32 = "0x" + "00".repeat(32);

function strip0x(hex: string) {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

// One 32-byte ABI word for a fixed `bytes32` value (must already be 32 bytes).
function bytes32Word(hex: string): Uint8Array {
  const bytes = hexToBytes(strip0x(hex));
  if (bytes.length > 32) throw new Error(`bytes32 overflow: ${hex}`);
  const word = new Uint8Array(32);
  word.set(bytes, 32 - bytes.length);
  return word;
}

// One 32-byte ABI word for an unsigned integer (big-endian, right-aligned).
function uintWord(value: number | bigint): Uint8Array {
  let v = BigInt(value);
  if (v < 0n) throw new Error("uint underflow");
  const word = new Uint8Array(32);
  for (let i = 31; i >= 0 && v > 0n; i -= 1) {
    word[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return word;
}

function keccakHex(bytes: Uint8Array): string {
  return "0x" + bytesToHex(keccak_256(bytes));
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// keccak256(abi.encode(...)) of an arbitrary word list. Mirrors Solidity exactly.
function abiKeccak(words: Uint8Array[]): string {
  return keccakHex(concatBytes(words));
}

/**
 * Packet digest === Solidity:
 * keccak256(abi.encode(bytes32 matchId, uint256 frame, uint256 player,
 *                      uint256 inputMask, bytes32 prevSelfHash, bytes32 prevOppHash))
 * This single value is both the signed message and the packet's chain hash.
 */
export function hashPacketFields(
  matchId: string,
  frame: number,
  player: PlayerSlot,
  inputMask: number,
  prevSelfHash: string,
  prevOppHash: string
): string {
  return abiKeccak([
    bytes32Word(matchId),
    uintWord(frame),
    uintWord(player),
    uintWord(inputMask),
    bytes32Word(prevSelfHash),
    bytes32Word(prevOppHash),
  ]);
}

/**
 * Canonical frame hash === Solidity:
 * keccak256(abi.encode(bytes32 matchId, uint256 frame, uint256 p1InputMask,
 *                      uint256 p2InputMask, bytes32 prevFrameHash))
 */
export function hashFrameFields(
  matchId: string,
  frame: number,
  p1InputMask: number,
  p2InputMask: number,
  prevFrameHash: string
): string {
  return abiKeccak([
    bytes32Word(matchId),
    uintWord(frame),
    uintWord(p1InputMask),
    uintWord(p2InputMask),
    bytes32Word(prevFrameHash),
  ]);
}

// Off-chain only: fingerprint of a JSON-serializable value (final state hash).
export function hashJson(value: unknown): string {
  return keccakHex(new TextEncoder().encode(JSON.stringify(value)));
}

// A random 32-byte match id (bytes32) so the contract can bind signed packets to it.
export function makeMatchId(): string {
  return "0x" + bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

// Ethereum-style address from an uncompressed secp256k1 public key.
export function addressFromPublicKey(publicKeyHex: string): string {
  const pub = hexToBytes(strip0x(publicKeyHex));
  const body = pub.length === 65 ? pub.slice(1) : pub; // drop 0x04 prefix
  return "0x" + bytesToHex(keccak_256(body)).slice(-40);
}

export async function createSessionWallet(): Promise<SessionWallet> {
  const privateKey = secp.utils.randomPrivateKey();
  const publicKey = "0x" + bytesToHex(secp.getPublicKey(privateKey, false));
  return {
    address: addressFromPublicKey(publicKey),
    publicKey,
    privateKey: "0x" + bytesToHex(privateKey),
  };
}

// secp256k1 recoverable signature over a 32-byte digest, as 65-byte hex (r||s||v).
export async function signDigest(privateKeyHex: string, digestHex: string): Promise<string> {
  const sig = await secp.signAsync(hexToBytes(strip0x(digestHex)), hexToBytes(strip0x(privateKeyHex)));
  const full = new Uint8Array(65);
  full.set(sig.toCompactRawBytes(), 0);
  full[64] = sig.recovery + 27;
  return "0x" + bytesToHex(full);
}

// Recover the signer address from a 65-byte signature over a digest.
export function recoverSigner(digestHex: string, signatureHex: string): string {
  const sig = hexToBytes(strip0x(signatureHex));
  if (sig.length !== 65) throw new Error("expected 65-byte signature");
  const recovery = sig[64] - 27;
  const recovered = secp.Signature.fromCompact(sig.slice(0, 64))
    .addRecoveryBit(recovery)
    .recoverPublicKey(hexToBytes(strip0x(digestHex)))
    .toRawBytes(false);
  return addressFromPublicKey("0x" + bytesToHex(recovered));
}

// A packet is valid if its recomputed digest matches packet.hash and the
// signature recovers to the session address committed in packet.publicKey.
export async function verifyPacket(packet: SignedInputPacket): Promise<boolean> {
  try {
    const digest = hashPacketFields(
      packet.matchId,
      packet.frame,
      packet.player,
      packet.inputMask,
      packet.prevSelfHash,
      packet.prevOppHash
    );
    if (digest !== packet.hash) return false;
    const signer = recoverSigner(digest, packet.signature);
    return signer.toLowerCase() === addressFromPublicKey(packet.publicKey).toLowerCase();
  } catch {
    return false;
  }
}
