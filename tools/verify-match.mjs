#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const crypto = globalThis.crypto ?? webcrypto;

const FPS = 30;
const ROUND_SECONDS = 10;
const ROUND_FRAMES = FPS * ROUND_SECONDS;
const WIDTH = 720;
const FLOOR_Y = 260;
const FIGHTER_W = 28;
const FIGHTER_H = 56;
const MOVE_SPEED = 5;
const ATTACK_ACTIVE_FRAMES = 4;
const ATTACK_COOLDOWN_FRAMES = 10;
const ATTACK_W = 18;
const ATTACK_H = 14;
const ATTACK_REACH = 22;
const DAMAGE = 1;
const MAX_HP = 7;
const INPUT = { LEFT: 1, RIGHT: 2, ATTACK: 4 };
const ZERO_HASH = "0x00";

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return "0x" + bytesToHex(new Uint8Array(digest));
}

function canonicalInputPayload(matchId, frame, player, inputMask, prevSelfHash, prevOppHash) {
  return JSON.stringify({ matchId, frame, player, inputMask, prevSelfHash, prevOppHash });
}

async function importVerifyKeyFromSpkiHex(spkiHex) {
  return crypto.subtle.importKey(
    "spki",
    hexToBytes(spkiHex),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"]
  );
}

async function verifyPacketSignature(packet) {
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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function decodeInputMask(mask) {
  return {
    left: !!(mask & INPUT.LEFT),
    right: !!(mask & INPUT.RIGHT),
    attack: !!(mask & INPUT.ATTACK),
  };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function getAttackRect(f) {
  if (f.attackActive <= 0) return null;
  const midY = f.y + Math.floor(f.h / 2) - Math.floor(ATTACK_H / 2);
  if (f.facing === 1) {
    return { x: f.x + f.w, y: midY, w: ATTACK_W + ATTACK_REACH, h: ATTACK_H };
  }
  return { x: f.x - (ATTACK_W + ATTACK_REACH), y: midY, w: ATTACK_W + ATTACK_REACH, h: ATTACK_H };
}

function initialState() {
  return {
    frame: 0,
    timerFramesLeft: ROUND_FRAMES,
    roundOver: false,
    winner: null,
    p1: { x: 120, y: FLOOR_Y - FIGHTER_H, w: FIGHTER_W, h: FIGHTER_H, hp: MAX_HP, facing: 1, attackCooldown: 0, attackActive: 0 },
    p2: { x: WIDTH - 120 - FIGHTER_W, y: FLOOR_Y - FIGHTER_H, w: FIGHTER_W, h: FIGHTER_H, hp: MAX_HP, facing: -1, attackCooldown: 0, attackActive: 0 },
  };
}

function transition(prev, p1Mask, p2Mask) {
  if (prev.roundOver) return prev;
  const s = JSON.parse(JSON.stringify(prev));
  s.frame += 1;
  s.timerFramesLeft = Math.max(0, s.timerFramesLeft - 1);

  const p1Input = decodeInputMask(p1Mask);
  const p2Input = decodeInputMask(p2Mask);

  s.p1.facing = s.p1.x <= s.p2.x ? 1 : -1;
  s.p2.facing = s.p2.x >= s.p1.x ? -1 : 1;

  if (s.p1.attackCooldown > 0) s.p1.attackCooldown -= 1;
  if (s.p2.attackCooldown > 0) s.p2.attackCooldown -= 1;
  if (s.p1.attackActive > 0) s.p1.attackActive -= 1;
  if (s.p2.attackActive > 0) s.p2.attackActive -= 1;

  const p1Move = (p1Input.left ? -MOVE_SPEED : 0) + (p1Input.right ? MOVE_SPEED : 0);
  const p2Move = (p2Input.left ? -MOVE_SPEED : 0) + (p2Input.right ? MOVE_SPEED : 0);

  s.p1.x = clamp(s.p1.x + p1Move, 0, WIDTH - s.p1.w);
  s.p2.x = clamp(s.p2.x + p2Move, 0, WIDTH - s.p2.w);

  s.p1.facing = s.p1.x <= s.p2.x ? 1 : -1;
  s.p2.facing = s.p2.x >= s.p1.x ? -1 : 1;

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

async function verifyTranscript(transcript) {
  const errors = [];
  const packetsByFrame = new Map();
  const packetHeads = { 1: ZERO_HASH, 2: ZERO_HASH };
  let frameHead = ZERO_HASH;
  let state = initialState();

  if (transcript.version !== 1) errors.push("unsupported transcript version");
  if (!transcript.matchId) errors.push("missing matchId");

  for (const packet of transcript.packets ?? []) {
    const key = `${packet.frame}:${packet.player}`;
    if (packetsByFrame.has(key)) errors.push(`duplicate packet ${key}`);
    packetsByFrame.set(key, packet);
  }

  const maxFrame = Math.max(0, ...(transcript.canonicalFrames ?? []).map((f) => f.frame));

  for (let frame = 1; frame <= maxFrame; frame += 1) {
    const p1 = packetsByFrame.get(`${frame}:1`);
    const p2 = packetsByFrame.get(`${frame}:2`);
    const canonical = transcript.canonicalFrames.find((f) => f.frame === frame);

    if (!p1 || !p2) {
      errors.push(`missing packet pair for frame ${frame}`);
      break;
    }
    if (!canonical) {
      errors.push(`missing canonical frame ${frame}`);
      break;
    }

    for (const packet of [p1, p2]) {
      const payload = canonicalInputPayload(packet.matchId, packet.frame, packet.player, packet.inputMask, packet.prevSelfHash, packet.prevOppHash);
      const expectedHash = await sha256Hex(payload);
      if (packet.matchId !== transcript.matchId) errors.push(`frame ${frame} P${packet.player}: wrong matchId`);
      if (packet.hash !== expectedHash) errors.push(`frame ${frame} P${packet.player}: hash mismatch`);
      if (packet.prevSelfHash !== packetHeads[packet.player]) errors.push(`frame ${frame} P${packet.player}: broken self chain`);
      const opponent = packet.player === 1 ? 2 : 1;
      if (packet.prevOppHash !== packetHeads[opponent]) errors.push(`frame ${frame} P${packet.player}: broken opponent acknowledgement`);

      const expectedPubKey = packet.player === 1 ? transcript.players?.p1?.publicKey : transcript.players?.p2?.publicKey;
      if (expectedPubKey && packet.publicKey !== expectedPubKey) errors.push(`frame ${frame} P${packet.player}: public key mismatch`);

      const signatureOk = await verifyPacketSignature(packet).catch(() => false);
      if (!signatureOk) errors.push(`frame ${frame} P${packet.player}: invalid signature`);
    }

    const expectedFrameHash = await sha256Hex(JSON.stringify({
      matchId: transcript.matchId,
      frame,
      p1InputMask: p1.inputMask,
      p2InputMask: p2.inputMask,
      prevFrameHash: frameHead,
    }));

    if (canonical.matchId !== transcript.matchId) errors.push(`frame ${frame}: canonical matchId mismatch`);
    if (canonical.p1InputMask !== p1.inputMask) errors.push(`frame ${frame}: p1 input mismatch`);
    if (canonical.p2InputMask !== p2.inputMask) errors.push(`frame ${frame}: p2 input mismatch`);
    if (canonical.prevFrameHash !== frameHead) errors.push(`frame ${frame}: prevFrameHash mismatch`);
    if (canonical.frameHash !== expectedFrameHash) errors.push(`frame ${frame}: frameHash mismatch`);

    packetHeads[1] = p1.hash;
    packetHeads[2] = p2.hash;
    frameHead = expectedFrameHash;
    state = transition(state, p1.inputMask, p2.inputMask);
  }

  const stateHash = await sha256Hex(JSON.stringify(state));
  if (transcript.final) {
    if (transcript.final.frame !== state.frame) errors.push(`final frame mismatch: transcript ${transcript.final.frame}, replay ${state.frame}`);
    if (transcript.final.frameHash !== frameHead) errors.push("final frame hash mismatch");
    if (transcript.final.stateHash && transcript.final.stateHash !== stateHash) errors.push("final state hash mismatch");
    if (transcript.final.p1Hp !== state.p1.hp) errors.push("final p1 hp mismatch");
    if (transcript.final.p2Hp !== state.p2.hp) errors.push("final p2 hp mismatch");
    if (transcript.final.winner !== state.winner) errors.push("final winner mismatch");
    if (transcript.final.roundOver !== state.roundOver) errors.push("final roundOver mismatch");
  }

  return {
    ok: errors.length === 0,
    errors,
    replay: {
      frame: state.frame,
      frameHash: frameHead,
      stateHash,
      p1Hp: state.p1.hp,
      p2Hp: state.p2.hp,
      winner: state.winner,
      roundOver: state.roundOver,
      packetHeads,
    },
  };
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run verify-match -- path/to/transcript.json");
    process.exit(2);
  }

  const transcript = JSON.parse(await readFile(file, "utf8"));
  const result = await verifyTranscript(transcript);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
