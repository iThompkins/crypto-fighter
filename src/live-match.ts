import { addressFromPublicKey, hashFrameFields, hashPacketFields, recoverSigner, signDigest, ZERO32 } from "./crypto.ts";
import { INPUT_DELAY, ROUND_FRAMES, initialState, transition } from "./game.ts";
import { verifyGenesisAuthorization, type GenesisRecord } from "./genesis.ts";
import { createPacketEvidence } from "./match-evidence.ts";
import type { EvidenceEvent, EvidenceStore } from "./evidence-store.ts";
import type { CanonicalFrame, PlayerSlot, SessionWallet, SignedInputPacket } from "./types.ts";
import { isValidV1InputMask } from "./input-mask.ts";

export { configHash, lifecycleDigest, parseLiveMessage, verifyReady, object, hex } from "./live-protocol.ts";
export type { LiveConfig, LiveMessage, Ready } from "./live-protocol.ts";
import { configHash, lifecycleDigest, parseLiveMessage, exact, object, type LiveConfig, type LiveMessage, type Ready } from "./live-protocol.ts";
import type { EvidenceArchive } from "./evidence-archive.ts";

export type LiveStatus = "prepared" | "running" | "disconnected" | "complete" | "conflict" | "storage-failed" | "inspection" | "closed";
export class LiveMatch {
  readonly context: string;
  private configValue: LiveConfig;
  get config() { return structuredClone(this.configValue); }
  private collector: ReturnType<typeof createPacketEvidence>;
  private ready = new Map<PlayerSlot, Ready>();
  private committed = new Map<string, SignedInputPacket>();
  private queue: Promise<unknown> = Promise.resolve();
  private key?: SessionWallet;
  private connected = true;
  private stopped: "conflict" | "storage-failed" | "closed" | undefined;
  private generation = 0;
  private needsReconcile = false;
  private signedMoves = new Map<number, Promise<SignedInputPacket>>();
  private state = initialState();
  private frames: CanonicalFrame[] = [];
  private frameHead = ZERO32;
  private history: EvidenceEvent[] = [];
  private store: EvidenceStore;
  readonly slot: PlayerSlot;
  private storageId: string;
  private constructor(config: LiveConfig, store: EvidenceStore, slot: PlayerSlot, key?: SessionWallet) {
    if (slot !== 1 && slot !== 2) throw new Error("Invalid local slot");
    this.store = store; this.slot = slot;
    this.configValue = structuredClone(config); this.context = configHash(config); this.storageId = `${this.context}:${slot}`;
    this.key = key && structuredClone(key);
    this.collector = createPacketEvidence(config.matchId, addressFromPublicKey(config.p1PublicKey), addressFromPublicKey(config.p2PublicKey));
  }
  static async create(config: LiveConfig, store: EvidenceStore, slot: PlayerSlot, key: SessionWallet, record?: GenesisRecord) {
    const match = new LiveMatch(config, store, slot, key);
    if (key.publicKey !== (slot === 1 ? config.p1PublicKey : config.p2PublicKey) || addressFromPublicKey(key.publicKey).toLowerCase() !== key.address.toLowerCase()) throw new Error("Local session not delegated");
    if (config.mode === "escrow" && (!record || !verifyGenesisAuthorization(config.authorization!, record))) throw new Error("Independent activated genesis lookup required");
    const publicRecord = config.mode === "escrow" && record ? { binding: structuredClone(config.authorization!.binding), authorized: record.authorized,
      registrationChallengeId: record.registrationChallengeId, ...(record.lookup ? { lookup: { chainId: record.lookup.chainId, arena: record.lookup.arena, challengeId: record.lookup.challengeId, blockNumber: record.lookup.blockNumber } } : {}) } : undefined;
    const genesis = { kind: "genesis", config: match.config, localSlot: slot, ...(publicRecord ? { record: publicRecord } : {}) };
    await store.initialize(match.storageId, genesis);
    match.history.push(structuredClone(genesis));
    return match;
  }
  static async recover(context: string, store: EvidenceStore) {
    const events = await store.read(context);
    const genesis = events[0];
    if (!genesis || genesis.kind !== "genesis" || !exact(genesis, ["kind", "config", "localSlot", ...((genesis.config as LiveConfig)?.mode === "escrow" ? ["record"] : [])])) throw new Error("Missing persisted genesis");
    if (genesis.localSlot !== 1 && genesis.localSlot !== 2) throw new Error("Invalid persisted slot");
    const match = new LiveMatch(genesis.config as LiveConfig, store, genesis.localSlot);
    if (match.storageId !== context) throw new Error("Corrupt evidence context");
    if (match.config.mode === "escrow" && !verifyGenesisAuthorization(match.config.authorization!, genesis.record as GenesisRecord)) throw new Error("Corrupt genesis evidence");
    match.history.push(structuredClone(genesis));
    for (const event of events.slice(1)) {
      if (event.kind === "message") {
        if (!exact(event, ["kind", "message"])) throw new Error("Corrupt message record");
        const message = parseLiveMessage(event.message);
        if (message.type === "REQUEST") throw new Error("Recovery hints are not evidence rows");
        await match.admit(message, false);
      }
      else if (event.kind === "observation") {
        const o = event.observation;
        if (!exact(event, ["kind", "observation"]) || !object(o) || !exact(o, ["kind", "localTime", "frame"]) || !["disconnect", "reconnect"].includes(String(o.kind)) || !Number.isSafeInteger(o.localTime) || Number(o.localTime) < 0 || !Number.isSafeInteger(o.frame) || Number(o.frame) < 0 || Number(o.frame) > ROUND_FRAMES) throw new Error("Corrupt local observation");
      } else throw new Error("Unknown evidence record");
      match.history.push(structuredClone(event));
    }
    match.advanceAvailable(true);
    return match;
  }
  get status(): LiveStatus {
    if (this.stopped === "closed") return "closed";
    if (!this.key) return "inspection";
    if (this.stopped) return this.stopped;
    if (this.state.roundOver) return "complete";
    if (!this.connected) return "disconnected";
    return this.ready.size === 2 ? "running" : "prepared";
  }
  // Transport replacement invalidates queued/in-flight work immediately.
  attach() { this.generation++; this.connected = false; return this.generation; }
  close() { this.generation++; this.stopped = "closed"; this.key = undefined; }
  private check(generation: number) { if (generation !== this.generation || this.stopped === "closed") throw new Error("Stale lifecycle generation"); }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  private async persist(event: EvidenceEvent) {
    try { await this.store.append(this.storageId, event); this.history.push(structuredClone(event)); }
    catch (error) { this.stopped = "storage-failed"; throw error; }
  }
  private async commit(event: EvidenceEvent, generation: number) {
    this.check(generation);
    await this.persist(event);
    if (generation !== this.generation) this.needsReconcile = true;
    this.check(generation);
  }
  private async reconcile(generation: number) {
    const restored = new LiveMatch(this.config, this.store, this.slot);
    for (const event of this.history) if (event.kind === "message") await restored.admit(parseLiveMessage(event.message), false);
    this.check(generation);
    this.collector = restored.collector; this.ready = restored.ready; this.committed = restored.committed;
    if (restored.stopped === "conflict") this.stopped = "conflict";
    this.needsReconcile = false;
  }
  private address(slot: PlayerSlot) { return addressFromPublicKey(slot === 1 ? this.config.p1PublicKey : this.config.p2PublicKey); }
  private async admit(message: LiveMessage, persist = true, generation = this.generation) {
    if (message.context !== this.context) throw new Error("Wrong match lifecycle");
    if (message.type === "INPUT") {
      if (this.ready.size !== 2) throw new Error("Both signed readiness statements required");
      const result = await this.collector.receive(message.packet, async () => {
        if (persist) await this.commit({ kind: "message", message }, generation);
      });
      if (persist) this.check(generation);
      if (result.kind === "unattributed-rejection") throw new Error(result.reason);
      if (result.kind === "equivocation") this.stopped = "conflict";
      if (result.kind === "authenticated-packet") this.committed.set(`${message.packet.player}:${message.packet.frame}`, result.packet);
    } else {
      if (recoverSigner(lifecycleDigest(this.context, message.slot, message.type, message.type === "REQUEST" ? message.frame : 0), message.signature).toLowerCase() !== this.address(message.slot)) throw new Error("Unauthorized lifecycle signer");
      if (message.type === "READY" && !this.ready.has(message.slot)) {
        if (persist) await this.commit({ kind: "message", message }, generation);
        this.ready.set(message.slot, message);
      }
    }
  }
  private validPackets() {
    return new Map(this.collector.validatedPackets().map(p => [`${p.player}:${p.frame}`, p]));
  }
  private advanceAvailable(all = false) {
    if (this.stopped || this.ready.size !== 2) return;
    const valid = this.validPackets();
    do {
      const frame = this.state.frame + 1;
      const p1 = valid.get(`1:${frame}`), p2 = valid.get(`2:${frame}`);
      if (!p1 || !p2 || this.state.roundOver) return;
      const frameHash = hashFrameFields(this.config.matchId, frame, p1.inputMask, p2.inputMask, this.frameHead);
      this.frames.push({ matchId: this.config.matchId, frame, p1InputMask: p1.inputMask, p2InputMask: p2.inputMask, prevFrameHash: this.frameHead, frameHash });
      this.frameHead = frameHash; this.state = transition(this.state, p1.inputMask, p2.inputMask);
    } while (all);
  }
  async receive(value: unknown, generation = this.generation): Promise<LiveMessage[]> {
    const message = parseLiveMessage(value);
    return this.serial(async () => {
      this.check(generation);
      if (!this.key || this.stopped === "storage-failed") throw new Error("Match cannot admit live messages");
      const remote = this.slot === 1 ? 2 : 1;
      if ((message.type === "INPUT" ? message.packet.player : message.slot) !== remote) throw new Error("Wrong participant slot");
      if (message.type === "INPUT" && message.packet.frame > this.state.frame + INPUT_DELAY + 2) throw new Error("Reordering window exceeded");
      await this.admit(message, true, generation); this.check(generation);
      if (message.type === "REQUEST") {
        const packet = this.committed.get(`${this.slot}:${message.frame}`);
        return packet ? [{ type: "INPUT", context: this.context, packet }] : [];
      }
      return [];
    });
  }
  async consent(generation = this.generation): Promise<Ready> {
    return this.serial(async () => {
      this.check(generation);
      if (!this.key || this.stopped) throw new Error("Signing authority unavailable");
      const old = this.ready.get(this.slot); if (old) return structuredClone(old);
      const signature = await signDigest(this.key.privateKey, lifecycleDigest(this.context, this.slot, "READY")); this.check(generation);
      const message: Ready = { type: "READY", context: this.context, slot: this.slot, signature };
      await this.admit(message, true, generation); this.check(generation); return message;
    });
  }
  async transport(connected: boolean, generation = this.generation) {
    return this.serial(async () => {
      this.check(generation);
      if (!this.key || this.stopped === "storage-failed") return;
      if (this.needsReconcile) await this.reconcile(generation);
      this.check(generation);
      if (this.history.filter(e => e.kind === "observation").length < 1024) await this.persist({ kind: "observation", observation: { kind: connected ? "reconnect" : "disconnect", localTime: Date.now(), frame: this.state.frame } });
      this.check(generation); this.connected = connected;
    });
  }
  retransmit(): LiveMessage[] {
    const ready = this.ready.get(this.slot);
    const packets = [...this.committed.values()].filter(p => p.player === this.slot);
    return [...(ready ? [structuredClone(ready)] : []), ...packets.slice(-INPUT_DELAY - 2).map(packet => ({ type: "INPUT" as const, context: this.context, packet: structuredClone(packet) }))];
  }
  async tick(mask: number, generation = this.generation): Promise<LiveMessage[]> {
    if (!isValidV1InputMask(mask)) throw new Error("Invalid input mask");
    return this.serial(async () => {
      this.check(generation);
      if (this.status !== "running" || !this.key) return [];
      const result: LiveMessage[] = [];
      const valid = this.validPackets();
      let frame = 1; while (this.committed.has(`${this.slot}:${frame}`)) frame++;
      while (frame <= Math.min(ROUND_FRAMES + INPUT_DELAY, this.state.frame + INPUT_DELAY)) {
        const prevSelfHash = frame === 1 ? ZERO32 : valid.get(`${this.slot}:${frame - 1}`)?.hash;
        const prevOppHash = frame <= INPUT_DELAY ? ZERO32 : valid.get(`${this.slot === 1 ? 2 : 1}:${frame - INPUT_DELAY}`)?.hash;
        if (!prevSelfHash || !prevOppHash) break;
        let signing = this.signedMoves.get(frame);
        if (!signing) {
          const hash = hashPacketFields(this.config.matchId, frame, this.slot, mask, prevSelfHash, prevOppHash);
          const fields = { matchId: this.config.matchId, frame, player: this.slot, inputMask: mask, prevSelfHash, prevOppHash, publicKey: this.key.publicKey, hash };
          signing = signDigest(this.key.privateKey, hash).then(signature => ({ ...fields, signature }));
          this.signedMoves.set(frame, signing);
        }
        const packet = await signing; this.check(generation);
        const message: LiveMessage = { type: "INPUT", context: this.context, packet };
        await this.admit(message, true, generation); this.check(generation);
        valid.set(`${this.slot}:${frame}`, packet); result.push(message); frame++;
      }
      this.advanceAvailable();
      return result;
    });
  }
  async requestMissing(generation = this.generation): Promise<LiveMessage | undefined> {
    return this.serial(async () => {
      this.check(generation);
      if (!this.key || this.status !== "running") return;
      const remote = this.slot === 1 ? 2 : 1;
      const frame = this.collector.firstMissing(remote);
      if (frame === undefined) return;
      const signature = await signDigest(this.key.privateKey, lifecycleDigest(this.context, this.slot, "REQUEST", frame)); this.check(generation);
      return { type: "REQUEST", context: this.context, slot: this.slot, frame, signature };
    });
  }
  exportEvidence(): Promise<EvidenceArchive> {
    // Queue barrier plus a transaction snapshot includes committed rows even if a
    // transport replacement interrupted their in-memory admission.
    return this.serial(async () => ({ format: "phase-b-journal-v1", journal: await this.store.read(this.storageId) }));
  }
  snapshot() { return structuredClone({ status: this.status, haltReason: this.stopped ?? null, config: this.config, context: this.context, state: this.state, frames: this.frames, frameHead: this.frameHead,
    packets: [...this.committed.values()], evidence: this.collector.export(), history: this.history, settlementEligible: false }); }
}
