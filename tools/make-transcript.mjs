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

const FPS = 30, ROUND_FRAMES = 300, WIDTH = 720, FLOOR_Y = 260;
const FW = 28, FH = 56, SPEED = 5, ATK_ACTIVE = 4, ATK_CD = 10, ATK_W = 18, ATK_H = 14, REACH = 22, DMG = 1, MAX_HP = 7;
const INPUT = { LEFT: 1, RIGHT: 2, ATTACK: 4 };
const ZERO32 = "0x" + "00".repeat(32);

const strip = (h) => (h.startsWith("0x") ? h.slice(2) : h);
const b32 = (h) => { const b = hexToBytes(strip(h)); const w = new Uint8Array(32); w.set(b, 32 - b.length); return w; };
const uint = (v) => { let x = BigInt(v); const w = new Uint8Array(32); for (let i = 31; i >= 0 && x > 0n; i--) { w[i] = Number(x & 0xffn); x >>= 8n; } return w; };
const cat = (arr) => { const n = arr.reduce((s, c) => s + c.length, 0), o = new Uint8Array(n); let p = 0; for (const c of arr) { o.set(c, p); p += c.length; } return o; };
const kec = (b) => "0x" + bytesToHex(keccak_256(b));
const packetHash = (m, f, pl, im, ps, po) => kec(cat([b32(m), uint(f), uint(pl), uint(im), b32(ps), b32(po)]));
const frameHash = (m, f, a, b, pf) => kec(cat([b32(m), uint(f), uint(a), uint(b), b32(pf)]));
const addr = (pubHex) => { const p = hexToBytes(strip(pubHex)); return "0x" + bytesToHex(keccak_256(p.length === 65 ? p.slice(1) : p)).slice(-40); };

function wallet() {
  const priv = secp.utils.randomPrivateKey();
  const publicKey = "0x" + bytesToHex(secp.getPublicKey(priv, false));
  return { priv, publicKey, address: addr(publicKey) };
}
function sign(priv, digest) {
  const s = secp.sign(hexToBytes(strip(digest)), priv);
  const full = new Uint8Array(65); full.set(s.toCompactRawBytes(), 0); full[64] = s.recovery + 27;
  return "0x" + bytesToHex(full);
}

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const decode = (m) => ({ left: !!(m & INPUT.LEFT), right: !!(m & INPUT.RIGHT), attack: !!(m & INPUT.ATTACK) });
function atkRect(f) { if (f.attackActive <= 0) return null; const y = f.y + Math.floor(f.h / 2) - Math.floor(ATK_H / 2); return f.facing === 1 ? { x: f.x + f.w, y, w: ATK_W + REACH, h: ATK_H } : { x: f.x - (ATK_W + REACH), y, w: ATK_W + REACH, h: ATK_H }; }
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
function initial() { return { frame: 0, timerFramesLeft: ROUND_FRAMES, roundOver: false, winner: null, p1: { x: 120, y: FLOOR_Y - FH, w: FW, h: FH, hp: MAX_HP, facing: 1, attackCooldown: 0, attackActive: 0 }, p2: { x: WIDTH - 120 - FW, y: FLOOR_Y - FH, w: FW, h: FH, hp: MAX_HP, facing: -1, attackCooldown: 0, attackActive: 0 } }; }
function transition(prev, m1, m2) {
  if (prev.roundOver) return prev;
  const s = JSON.parse(JSON.stringify(prev)); s.frame++; s.timerFramesLeft = Math.max(0, s.timerFramesLeft - 1);
  const i1 = decode(m1), i2 = decode(m2);
  if (s.p1.attackCooldown > 0) s.p1.attackCooldown--; if (s.p2.attackCooldown > 0) s.p2.attackCooldown--;
  if (s.p1.attackActive > 0) s.p1.attackActive--; if (s.p2.attackActive > 0) s.p2.attackActive--;
  s.p1.x = clamp(s.p1.x + (i1.left ? -SPEED : 0) + (i1.right ? SPEED : 0), 0, WIDTH - s.p1.w);
  s.p2.x = clamp(s.p2.x + (i2.left ? -SPEED : 0) + (i2.right ? SPEED : 0), 0, WIDTH - s.p2.w);
  s.p1.facing = s.p1.x <= s.p2.x ? 1 : -1; s.p2.facing = s.p2.x >= s.p1.x ? -1 : 1;
  if (i1.attack && s.p1.attackCooldown === 0 && s.p1.attackActive === 0) { s.p1.attackActive = ATK_ACTIVE; s.p1.attackCooldown = ATK_CD; }
  if (i2.attack && s.p2.attackCooldown === 0 && s.p2.attackActive === 0) { s.p2.attackActive = ATK_ACTIVE; s.p2.attackCooldown = ATK_CD; }
  const a1 = atkRect(s.p1), a2 = atkRect(s.p2);
  if (a1 && overlap(a1, { x: s.p2.x, y: s.p2.y, w: s.p2.w, h: s.p2.h })) s.p2.hp = Math.max(0, s.p2.hp - DMG);
  if (a2 && overlap(a2, { x: s.p1.x, y: s.p1.y, w: s.p1.w, h: s.p1.h })) s.p1.hp = Math.max(0, s.p1.hp - DMG);
  if (s.p1.hp === 0 && s.p2.hp === 0) { s.roundOver = true; s.winner = "TIE_BOTH_LOSE"; }
  else if (s.p1.hp === 0) { s.roundOver = true; s.winner = "P2"; }
  else if (s.p2.hp === 0) { s.roundOver = true; s.winner = "P1"; }
  else if (s.timerFramesLeft === 0) { s.roundOver = true; s.winner = s.p1.hp > s.p2.hp ? "P1" : s.p2.hp > s.p1.hp ? "P2" : "TIE_BOTH_LOSE"; }
  return s;
}

async function main() {
  const matchId = "0x" + bytesToHex(secp.etc ? crypto.getRandomValues(new Uint8Array(32)) : new Uint8Array(32));
  const p1 = wallet(), p2 = wallet();
  let state = initial();
  const D = 2; // input delay
  const hist = { 1: {}, 2: {} };
  let frameHead = ZERO32;
  const packets = [], canonicalFrames = [];

  for (let frame = 1; frame <= ROUND_FRAMES && !state.roundOver; frame++) {
    // P1 policy: close distance, then attack. P2 idle.
    const gap = state.p2.x - (state.p1.x + state.p1.w);
    const m1 = gap > REACH + ATK_W - 4 ? INPUT.RIGHT : INPUT.ATTACK;
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

  const stateHash = kec(new TextEncoder().encode(JSON.stringify(state)));
  const transcript = {
    version: 1, matchId,
    rules: { fps: FPS, roundFrames: ROUND_FRAMES, maxHp: MAX_HP, oneOutstandingPacket: true, inputDelay: D },
    players: { p1: { slot: 1, address: p1.address, publicKey: p1.publicKey }, p2: { slot: 2, address: p2.address, publicKey: p2.publicKey } },
    packets, canonicalFrames,
    final: { frame: state.frame, frameHash: frameHead, stateHash, p1Hp: state.p1.hp, p2Hp: state.p2.hp, winner: state.winner, roundOver: state.roundOver },
  };
  const out = process.argv[2] || "decisive-transcript.json";
  await writeFile(out, JSON.stringify(transcript, null, 2));
  console.log(`wrote ${out}: winner=${state.winner} frame=${state.frame} hp=${state.p1.hp}-${state.p2.hp} packets=${packets.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
