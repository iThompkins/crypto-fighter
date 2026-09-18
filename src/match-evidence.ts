import { addressFromPublicKey, verifyPacket, ZERO32 } from "./crypto.ts";
import { INPUT_DELAY, ROUND_FRAMES } from "./game.ts";
import { hashGenesisBinding, verifyGenesisAuthorization, type GenesisAuthorization, type GenesisRecord } from "./genesis.ts";
import { isValidV1InputMask } from "./input-mask.ts";
import type { SignedInputPacket } from "./types.ts";

export type PacketEvidence =
  | { kind: "unattributed-rejection"; reason: string }
  | { kind: "authenticated-packet"; packet: SignedInputPacket; duplicate: boolean }
  | { kind: "equivocation"; packets: [SignedInputPacket, SignedInputPacket] };
export type ChainEvidence = { kind: "ready" } | { kind: "missing-dependency"; player: 1 | 2; frame: number }
  | { kind: "chain-mismatch"; packet: SignedInputPacket; dependency?: SignedInputPacket; chain: "self" | "opponent" };

// The record must be obtained from a pinned trusted chain lookup, never from a peer.
// This collector establishes evidence only; it has no winner or payout authority.
export function createMatchEvidence(authorization: GenesisAuthorization, record: GenesisRecord) {
  if (!verifyGenesisAuthorization(authorization, record)) throw new Error("authorized genesis required");
  return createPacketEvidence(record.binding.genesis, record.binding.p1Session, record.binding.p2Session,
    { bindingHash: hashGenesisBinding(record.binding), authorization: structuredClone(authorization) });
}

export function createPacketEvidence(matchId: string, p1Session: string, p2Session: string, metadata: object = {}) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  const packets = new Map<string, SignedInputPacket[]>();
  const observations: { kind: "disconnect" | "stall" | "reconnect"; localTime: number; frame: number }[] = [];
  const key = (player: number, frame: number) => `${player}:${frame}`;
  return {
    async receive(value: unknown, commit?: (packet: SignedInputPacket) => Promise<void>): Promise<PacketEvidence> {
      // Snapshot before queueing as callers may mutate their packet immediately.
      let p: SignedInputPacket;
      try { p = structuredClone(value) as SignedInputPacket; } catch { return { kind: "unattributed-rejection", reason: "malformed packet" }; }
      return serial<PacketEvidence>(async () => {
        const hex = (v: unknown, size: number) => typeof v === "string" && new RegExp(`^0x[0-9a-fA-F]{${size * 2}}$`).test(v);
        if (!p || typeof p !== "object" || Object.keys(p).length !== 9 || (p.player !== 1 && p.player !== 2) || !Number.isSafeInteger(p.frame) || p.frame < 1 || p.frame > ROUND_FRAMES + INPUT_DELAY ||
            !isValidV1InputMask(p.inputMask) || !hex(p.matchId, 32) || !hex(p.hash, 32) || !hex(p.prevSelfHash, 32) || !hex(p.prevOppHash, 32) || !hex(p.signature, 65) || !hex(p.publicKey, 65)) {
          return { kind: "unattributed-rejection", reason: "malformed packet" };
        }
        if (p.matchId !== matchId) return { kind: "unattributed-rejection", reason: "wrong genesis" };
        const expected = p.player === 1 ? p1Session : p2Session;
        try {
          if (addressFromPublicKey(p.publicKey).toLowerCase() !== expected.toLowerCase() || !await verifyPacket(p)) {
            return { kind: "unattributed-rejection", reason: "invalid authentication" };
          }
        } catch { return { kind: "unattributed-rejection", reason: "invalid authentication" }; }
        const id = key(p.player, p.frame);
        const previous = packets.get(id) ?? [];
        if (previous.some(existing => existing.hash === p.hash)) return { kind: "authenticated-packet", packet: structuredClone(p), duplicate: true };
        // Preserve both signed statements, including conflicts arriving after simulation.
        if (previous.length >= 2) return { kind: "equivocation", packets: structuredClone([previous[0], previous[1]]) };
        if (commit) await commit(structuredClone(p));
        previous.push(p);
        packets.set(id, previous);
        if (previous.length > 1) return { kind: "equivocation", packets: structuredClone([previous[0], p]) };
        return { kind: "authenticated-packet", packet: structuredClone(p), duplicate: false };
      });
    },
    chainEvidence(player: 1 | 2, frame: number): ChainEvidence {
      const p = packets.get(key(player, frame))?.[0];
      if (!p) return { kind: "missing-dependency", player, frame };
      const opposite = player === 1 ? 2 : 1;
      for (const [chain, dependencyPlayer, dependencyFrame, claimed] of [
        ["self", player, frame - 1, p.prevSelfHash],
        ["opponent", opposite, frame - INPUT_DELAY, p.prevOppHash],
      ] as const) {
        if (dependencyFrame < 1) {
          if (claimed !== ZERO32) return { kind: "chain-mismatch", packet: structuredClone(p), chain };
          continue;
        }
        const dependencies = packets.get(key(dependencyPlayer, dependencyFrame));
        if (!dependencies) return { kind: "missing-dependency", player: dependencyPlayer, frame: dependencyFrame };
        if (!dependencies.some(d => d.hash === claimed)) return { kind: "chain-mismatch", packet: structuredClone(p), dependency: structuredClone(dependencies[0]), chain };
      }
      return { kind: "ready" };
    },
    validatedPackets() {
      const valid = new Map<string, SignedInputPacket>();
      for (let frame = 1; frame <= ROUND_FRAMES + INPUT_DELAY; frame++) for (const player of [1, 2] as const) {
        const variants = packets.get(key(player, frame));
        if (!variants || variants.length !== 1) continue;
        const p = variants[0];
        const self = frame === 1 ? ZERO32 : valid.get(key(player, frame - 1))?.hash;
        const other = frame <= INPUT_DELAY ? ZERO32 : valid.get(key(player === 1 ? 2 : 1, frame - INPUT_DELAY))?.hash;
        if (p.prevSelfHash === self && p.prevOppHash === other) valid.set(key(player, frame), p);
      }
      return structuredClone([...valid.values()]);
    },
    firstMissing(player: 1 | 2) {
      let frame = 1;
      while (packets.has(key(player, frame))) frame++;
      return frame <= ROUND_FRAMES + INPUT_DELAY ? frame : undefined;
    },
    observe(kind: "disconnect" | "stall" | "reconnect", localTime: number, frame: number) {
      if (!["disconnect", "stall", "reconnect"].includes(kind) || !Number.isSafeInteger(localTime) || localTime < 0 || !Number.isSafeInteger(frame) || frame < 0 || frame > ROUND_FRAMES) throw new Error("invalid local observation");
      if (observations.length < 1024) observations.push({ kind, localTime, frame });
    },
    export() {
      return structuredClone({ version: 1 as const, ...metadata,
        packets: [...packets.values()].flat(), observations, settlementEligible: false as const });
    },
  };
}
