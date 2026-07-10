import type { PlayerSlot, SessionWallet, SignedInputPacket } from "./types";

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

export async function sha256Hex(input: string) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return "0x" + bytesToHex(new Uint8Array(digest));
}

async function exportSpkiHex(publicKey: CryptoKey) {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  return "0x" + bytesToHex(new Uint8Array(spki));
}

async function deriveAddressFromPublicKey(publicKey: CryptoKey) {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const digest = await crypto.subtle.digest("SHA-256", spki);
  const hex = bytesToHex(new Uint8Array(digest));
  return "0x" + hex.slice(-40);
}

export async function createSessionWallet(): Promise<SessionWallet> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"]
  );

  const publicKey = await exportSpkiHex(pair.publicKey);
  const address = await deriveAddressFromPublicKey(pair.publicKey);

  return {
    address,
    publicKey,
    privateKey: pair.privateKey,
  };
}

export function canonicalInputPayload(
  matchId: string,
  frame: number,
  player: PlayerSlot,
  inputMask: number,
  prevSelfHash: string,
  prevOppHash: string
) {
  return JSON.stringify({
    matchId,
    frame,
    player,
    inputMask,
    prevSelfHash,
    prevOppHash,
  });
}

export async function signPayload(privateKey: CryptoKey, payload: string) {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(payload)
  );
  return "0x" + bytesToHex(new Uint8Array(signature));
}

async function importVerifyKeyFromSpkiHex(spkiHex: string) {
  return crypto.subtle.importKey(
    "spki",
    hexToBytes(spkiHex),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"]
  );
}

export async function verifyPacket(packet: SignedInputPacket) {
  const key = await importVerifyKeyFromSpkiHex(packet.publicKey);
  const payload = canonicalInputPayload(
    packet.matchId,
    packet.frame,
    packet.player,
    packet.inputMask,
    packet.prevSelfHash,
    packet.prevOppHash
  );

  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    hexToBytes(packet.signature),
    new TextEncoder().encode(payload)
  );
}
