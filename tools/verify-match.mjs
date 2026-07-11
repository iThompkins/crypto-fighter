#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import * as secp from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

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
const INPUT = { LEFT: 1, RIGHT: 2, ATTACK: 4, UP: 8 };
const JUMP_VELOCITY = 22;
const GRAVITY = 2;
const ZERO_HASH = "0x" + "00".repeat(32);

function strip0x(hex) {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function bytes32Word(hex) {
  const bytes = hexToBytes(strip0x(hex));
  if (bytes.length > 32) throw new Error(`bytes32 overflow: ${hex}`);
  const word = new Uint8Array(32);
  word.set(bytes, 32 - bytes.length);
  return word;
}

function uintWord(value) {
  let v = BigInt(value);
  const word = new Uint8Array(32);
  for (let i = 31; i >= 0 && v > 0n; i -= 1) {
    word[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return word;
}

function concatBytes(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function keccakHex(bytes) {
  return "0x" + bytesToHex(keccak_256(bytes));
}

function hashPacketFields(matchId, frame, player, inputMask, prevSelfHash, prevOppHash) {
  return keccakHex(concatBytes([
    bytes32Word(matchId),
    uintWord(frame),
    uintWord(player),
    uintWord(inputMask),
    bytes32Word(prevSelfHash),
    bytes32Word(prevOppHash),
  ]));
}

function hashFrameFields(matchId, frame, p1InputMask, p2InputMask, prevFrameHash) {
  return keccakHex(concatBytes([
    bytes32Word(matchId),
    uintWord(frame),
    uintWord(p1InputMask),
    uintWord(p2InputMask),
    bytes32Word(prevFrameHash),
  ]));
}

function hashJson(value) {
  return keccakHex(new TextEncoder().encode(JSON.stringify(value)));
}

function addressFromPublicKey(publicKeyHex) {
  const pub = hexToBytes(strip0x(publicKeyHex));
  const body = pub.length === 65 ? pub.slice(1) : pub;
  return "0x" + bytesToHex(keccak_256(body)).slice(-40);
}

function verifyPacketSignature(packet) {
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
    const sig = hexToBytes(strip0x(packet.signature));
    if (sig.length !== 65) return false;
    const recovered = secp.Signature.fromCompact(sig.slice(0, 64))
      .addRecoveryBit(sig[64] - 27)
      .recoverPublicKey(hexToBytes(strip0x(digest)))
      .toRawBytes(false);
    const signer = addressFromPublicKey("0x" + bytesToHex(recovered));
    return signer.toLowerCase() === addressFromPublicKey(packet.publicKey).toLowerCase();
  } catch {
    return false;
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function decodeInputMask(mask) {
  return {
    left: !!(mask & INPUT.LEFT),
    right: !!(mask & INPUT.RIGHT),
    attack: !!(mask & INPUT.ATTACK),
    up: !!(mask & INPUT.UP),
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
    p1: { x: 120, y: FLOOR_Y - FIGHTER_H, w: FIGHTER_W, h: FIGHTER_H, hp: MAX_HP, facing: 1, attackCooldown: 0, attackActive: 0, vy: 0 },
    p2: { x: WIDTH - 120 - FIGHTER_W, y: FLOOR_Y - FIGHTER_H, w: FIGHTER_W, h: FIGHTER_H, hp: MAX_HP, facing: -1, attackCooldown: 0, attackActive: 0, vy: 0 },
  };
}

function transition(prev, p1Mask, p2Mask) {
  if (prev.roundOver) return prev;
  const s = JSON.parse(JSON.stringify(prev));
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

  const groundY = FLOOR_Y - s.p1.h;
  if (p1Input.up && s.p1.y >= groundY) s.p1.vy = -JUMP_VELOCITY;
  if (p2Input.up && s.p2.y >= groundY) s.p2.vy = -JUMP_VELOCITY;
  s.p1.vy += GRAVITY;
  s.p2.vy += GRAVITY;
  s.p1.y += s.p1.vy;
  s.p2.y += s.p2.vy;
  if (s.p1.y >= groundY) { s.p1.y = groundY; s.p1.vy = 0; }
  if (s.p2.y >= groundY) { s.p2.y = groundY; s.p2.vy = 0; }

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

async function verifyTranscript(transcript) {
  const errors = [];
  const packetsByFrame = new Map();
  const packetHeads = { 1: ZERO_HASH, 2: ZERO_HASH };
  const inputDelay = transcript.rules?.inputDelay ?? 1;
  const hist = { 1: {}, 2: {} };
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
      const expectedHash = hashPacketFields(packet.matchId, packet.frame, packet.player, packet.inputMask, packet.prevSelfHash, packet.prevOppHash);
      if (packet.matchId !== transcript.matchId) errors.push(`frame ${frame} P${packet.player}: wrong matchId`);
      if (packet.hash !== expectedHash) errors.push(`frame ${frame} P${packet.player}: hash mismatch`);
      if (packet.prevSelfHash !== packetHeads[packet.player]) errors.push(`frame ${frame} P${packet.player}: broken self chain`);
      const opponent = packet.player === 1 ? 2 : 1;
      const ackFrame = frame - inputDelay;
      const expectedOpp = ackFrame >= 1 ? hist[opponent][ackFrame] : ZERO_HASH;
      if (packet.prevOppHash !== expectedOpp) errors.push(`frame ${frame} P${packet.player}: broken opponent acknowledgement`);

      const expectedPubKey = packet.player === 1 ? transcript.players?.p1?.publicKey : transcript.players?.p2?.publicKey;
      if (expectedPubKey && packet.publicKey !== expectedPubKey) errors.push(`frame ${frame} P${packet.player}: public key mismatch`);

      const signatureOk = verifyPacketSignature(packet);
      if (!signatureOk) errors.push(`frame ${frame} P${packet.player}: invalid signature`);
    }

    const expectedFrameHash = hashFrameFields(transcript.matchId, frame, p1.inputMask, p2.inputMask, frameHead);

    if (canonical.matchId !== transcript.matchId) errors.push(`frame ${frame}: canonical matchId mismatch`);
    if (canonical.p1InputMask !== p1.inputMask) errors.push(`frame ${frame}: p1 input mismatch`);
    if (canonical.p2InputMask !== p2.inputMask) errors.push(`frame ${frame}: p2 input mismatch`);
    if (canonical.prevFrameHash !== frameHead) errors.push(`frame ${frame}: prevFrameHash mismatch`);
    if (canonical.frameHash !== expectedFrameHash) errors.push(`frame ${frame}: frameHash mismatch`);

    packetHeads[1] = p1.hash;
    packetHeads[2] = p2.hash;
    hist[1][frame] = p1.hash;
    hist[2][frame] = p2.hash;
    frameHead = expectedFrameHash;
    state = transition(state, p1.inputMask, p2.inputMask);
  }

  const stateHash = hashJson(state);
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
