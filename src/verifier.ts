import { addressFromPublicKey, hashFrameFields, hashJson, hashPacketFields, verifyPacket, ZERO32 } from "./crypto.ts";
import { initialState, transition } from "./game.ts";
import { isValidV1InputMask } from "./input-mask.ts";
import type { GameState, MatchTranscript, SignedInputPacket } from "./types.ts";

const ZERO_HASH = ZERO32;

export type TranscriptVerificationResult = {
  ok: boolean;
  errors: string[];
  states: GameState[];
  replay: {
    frame: number;
    frameHash: string;
    stateHash: string;
    p1Hp: number;
    p2Hp: number;
    winner: GameState["winner"];
    roundOver: boolean;
    packetHeads: { 1: string; 2: string };
  };
};

function packetKey(packet: SignedInputPacket) {
  return `${packet.frame}:${packet.player}`;
}

function inputMaskErrors(transcript: MatchTranscript): string[] {
  const errors: string[] = [];
  const packets = transcript.packets ?? [];
  const canonicalFrames = transcript.canonicalFrames ?? [];

  for (let i = 0; i < packets.length; i += 1) {
    if (!isValidV1InputMask(packets[i]?.inputMask)) {
      errors.push(`invalid v1 input mask at packets[${i}].inputMask`);
    }
  }
  for (let i = 0; i < canonicalFrames.length; i += 1) {
    if (!isValidV1InputMask(canonicalFrames[i]?.p1InputMask)) {
      errors.push(`invalid v1 input mask at canonicalFrames[${i}].p1InputMask`);
    }
    if (!isValidV1InputMask(canonicalFrames[i]?.p2InputMask)) {
      errors.push(`invalid v1 input mask at canonicalFrames[${i}].p2InputMask`);
    }
  }

  return errors;
}

export async function verifyTranscript(transcript: MatchTranscript): Promise<TranscriptVerificationResult> {
  const maskErrors = inputMaskErrors(transcript);
  if (maskErrors.length > 0) {
    const state = initialState();
    return {
      ok: false,
      errors: maskErrors,
      states: [state],
      replay: {
        frame: state.frame,
        frameHash: ZERO_HASH,
        stateHash: ZERO_HASH,
        p1Hp: state.p1.hp,
        p2Hp: state.p2.hp,
        winner: state.winner,
        roundOver: state.roundOver,
        packetHeads: { 1: ZERO_HASH, 2: ZERO_HASH },
      },
    };
  }

  const errors: string[] = [];
  const packetsByFrame = new Map<string, SignedInputPacket>();
  const packetHeads: { 1: string; 2: string } = { 1: ZERO_HASH, 2: ZERO_HASH };
  const inputDelay = transcript.rules?.inputDelay ?? 1;
  const hist: { 1: Record<number, string>; 2: Record<number, string> } = { 1: {}, 2: {} };
  const states: GameState[] = [initialState()];
  let frameHead = ZERO_HASH;
  let state = initialState();

  if (transcript.version !== 1) errors.push("unsupported transcript version");
  if (!transcript.matchId) errors.push("missing matchId");

  const transcriptPlayers = [transcript.players?.p1, transcript.players?.p2] as const;
  for (const [index, player] of transcriptPlayers.entries()) {
    const expectedSlot = (index + 1) as 1 | 2;
    if (!player) {
      errors.push(`missing P${expectedSlot} identity`);
      continue;
    }
    if (player.slot !== expectedSlot) errors.push(`P${expectedSlot} identity has wrong slot`);
    if (!player.publicKey) {
      errors.push(`missing P${expectedSlot} public key`);
      continue;
    }
    if (!player.address) {
      errors.push(`missing P${expectedSlot} session address`);
      continue;
    }
    try {
      const derived = addressFromPublicKey(player.publicKey);
      if (derived.toLowerCase() !== player.address.toLowerCase()) {
        errors.push(`P${expectedSlot} session address does not match public key`);
      }
    } catch {
      errors.push(`P${expectedSlot} public key is malformed`);
    }
  }

  for (const packet of transcript.packets ?? []) {
    const key = packetKey(packet);
    if (packetsByFrame.has(key)) errors.push(`duplicate packet ${key}`);
    packetsByFrame.set(key, packet);
  }

  const canonicalFrames = transcript.canonicalFrames ?? [];
  const maxFrame = Math.max(0, ...canonicalFrames.map((frame) => frame.frame));

  for (let frame = 1; frame <= maxFrame; frame += 1) {
    const p1 = packetsByFrame.get(`${frame}:1`);
    const p2 = packetsByFrame.get(`${frame}:2`);
    const canonical = canonicalFrames.find((candidate) => candidate.frame === frame);

    if (!p1 || !p2) {
      errors.push(`missing packet pair for frame ${frame}`);
      break;
    }
    if (!canonical) {
      errors.push(`missing canonical frame ${frame}`);
      break;
    }

    for (const packet of [p1, p2]) {
      const expectedHash = hashPacketFields(
        packet.matchId,
        packet.frame,
        packet.player,
        packet.inputMask,
        packet.prevSelfHash,
        packet.prevOppHash
      );

      if (packet.matchId !== transcript.matchId) errors.push(`frame ${frame} P${packet.player}: wrong matchId`);
      if (packet.hash !== expectedHash) errors.push(`frame ${frame} P${packet.player}: hash mismatch`);
      if (packet.prevSelfHash !== packetHeads[packet.player]) errors.push(`frame ${frame} P${packet.player}: broken self chain`);

      const opponent = packet.player === 1 ? 2 : 1;
      const ackFrame = frame - inputDelay;
      const expectedOpp = ackFrame >= 1 ? hist[opponent][ackFrame] : ZERO_HASH;
      if (packet.prevOppHash !== expectedOpp) {
        errors.push(`frame ${frame} P${packet.player}: broken opponent acknowledgement`);
      }

      const expectedPubKey = packet.player === 1 ? transcript.players?.p1?.publicKey : transcript.players?.p2?.publicKey;
      if (!expectedPubKey || packet.publicKey !== expectedPubKey) {
        errors.push(`frame ${frame} P${packet.player}: public key mismatch`);
      }

      const signatureOk = await verifyPacket(packet).catch(() => false);
      if (!signatureOk) errors.push(`frame ${frame} P${packet.player}: invalid signature`);
    }

    const expectedFrameHash = hashFrameFields(
      transcript.matchId,
      frame,
      p1.inputMask,
      p2.inputMask,
      frameHead
    );

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
    states.push(state);
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
    states,
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
