#!/usr/bin/env node
// Deterministically generate a decisive, fully-signed match transcript so the
// end-game UI (winner banner, final settlement payload) can be demonstrated via
// the app's Transcript replay without relying on flaky real-time lockstep.
import { writeFile } from "node:fs/promises";
import * as secp from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";
import { hmac } from "@noble/hashes/hmac";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

import "./register-types.mjs";
const { ROUND_FRAMES, FIGHTER_W, ATTACK_REACH, ATTACK_W, SCALE, INPUT, INPUT_DELAY, initialState, transition } = await import("../src/game.ts");
const { CANONICAL_RULES, CANONICAL_RULES_HASH, hashTraceState } = await import("../src/protocol.ts");
const ZERO32 = "0x" + "00".repeat(32);

const strip = (h) => (h.startsWith("0x") ? h.slice(2) : h);
const b32 = (h) => { const b = hexToBytes(strip(h)); const w = new Uint8Array(32); w.set(b, 32 - b.length); return w; };
const uint = (v) => { let x = BigInt(v); const w = new Uint8Array(32); for (let i = 31; i >= 0 && x > 0n; i--) { w[i] = Number(x & 0xffn); x >>= 8n; } return w; };
const cat = (arr) => { const n = arr.reduce((s, c) => s + c.length, 0), o = new Uint8Array(n); let p = 0; for (const c of arr) { o.set(c, p); p += c.length; } return o; };
const kec = (b) => "0x" + bytesToHex(keccak_256(b));
const packetHash = (m, f, pl, im, ps, po) => kec(cat([b32(m), uint(f), uint(pl), uint(im), b32(ps), b32(po)]));
const frameHash = (m, f, a, b, pf) => kec(cat([b32(m), uint(f), uint(a), uint(b), b32(pf)]));
const addr = (pubHex) => { const p = hexToBytes(strip(pubHex)); return "0x" + bytesToHex(keccak_256(p.length === 65 ? p.slice(1) : p)).slice(-40); };

// Public fixture-only identities; never used for browser or escrow wallets.
function wallet(scalar) {
  const priv = hexToBytes(scalar.toString(16).padStart(64, "0"));
  const publicKey = "0x" + bytesToHex(secp.getPublicKey(priv, false));
  return { priv, publicKey, address: addr(publicKey) };
}
function sign(priv, digest) {
  const s = secp.sign(hexToBytes(strip(digest)), priv);
  const full = new Uint8Array(65); full.set(s.toCompactRawBytes(), 0); full[64] = s.recovery + 27;
  return "0x" + bytesToHex(full);
}

async function main() {
  const matchId = "0x" + "11".repeat(32);
  const p1 = wallet(1), p2 = wallet(2);
  let state = initialState();
  const D = INPUT_DELAY; // input delay
  const hist = { 1: {}, 2: {} };
  let frameHead = ZERO32;
  const packets = [], canonicalFrames = [];

  for (let frame = 1; frame <= ROUND_FRAMES && !state.roundOver; frame++) {
    // P1 policy: close distance, then attack. P2 idle.
    const gap = state.p2.x - (state.p1.x + FIGHTER_W);
    const m1 = gap > ATTACK_REACH + ATTACK_W - 4 * SCALE ? INPUT.RIGHT : INPUT.ATTACK;
    const m2 = 0;
    const masks = { 1: m1, 2: m2 };
    const keys = { 1: p1, 2: p2 };
    for (const player of [1, 2]) {
      const opp = player === 1 ? 2 : 1;
      const ps = frame > 1 ? hist[player][frame - 1] : ZERO32;
      const ack = frame - D;
      const po = ack >= 1 ? hist[opp][ack] : ZERO32;
      const hash = packetHash(matchId, frame, player, masks[player], ps, po);
      packets.push({ matchId, frame, player, inputMask: masks[player], prevSelfHash: ps, prevOppHash: po, publicKey: keys[player].publicKey, signature: sign(keys[player].priv, hash), hash });
      hist[player][frame] = hash;
    }
    const p1p = packets[packets.length - 2], p2p = packets[packets.length - 1];
    const fh = frameHash(matchId, frame, p1p.inputMask, p2p.inputMask, frameHead);
    canonicalFrames.push({ matchId, frame, p1InputMask: p1p.inputMask, p2InputMask: p2p.inputMask, prevFrameHash: frameHead, frameHash: fh });
    frameHead = fh;
    state = transition(state, p1p.inputMask, p2p.inputMask);
  }

  const stateHash = hashTraceState(state);
  const transcript = {
    version: 2, rulesHash: CANONICAL_RULES_HASH, matchId,
    rules: CANONICAL_RULES,
    players: { p1: { slot: 1, address: p1.address, publicKey: p1.publicKey }, p2: { slot: 2, address: p2.address, publicKey: p2.publicKey } },
    packets, canonicalFrames,
    final: { frame: state.frame, frameHash: frameHead, stateHash, p1Hp: state.p1.hp, p2Hp: state.p2.hp, winner: state.winner, roundOver: state.roundOver },
  };
  const out = process.argv[2] || "decisive-transcript.json";
  await writeFile(out, JSON.stringify(transcript, null, 2));
  console.log(`wrote ${out}: winner=${state.winner} frame=${state.frame} hp=${state.p1.hp}-${state.p2.hp} packets=${packets.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
