import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveMatch, configHash, lifecycleDigest } from '../src/live-match.ts';
import { hello, verifyHello } from '../src/live-discovery.ts';
import { hashPacketFields, ZERO32 } from '../src/crypto.ts';
import { CANONICAL_RULES_HASH } from '../src/protocol.ts';
import { auth, record, w1, w2, binding } from './fixtures/genesis.mjs';
const key = w => ({ address: w.address, publicKey: w.signingKey.publicKey, privateKey: w.privateKey });
const config = { version: 1, mode: 'practice', matchId: binding.genesis, rulesHash: CANONICAL_RULES_HASH, p1PublicKey: w1.signingKey.publicKey, p2PublicKey: w2.signingKey.publicKey };
class MemoryStore {
  rows = new Map(); fail = false; gate;
  async initialize(context, event) { if (this.rows.has(context)) throw Error('Existing evidence'); this.rows.set(context, [structuredClone(event)]); }
  async append(context, event) { if (this.gate) await this.gate; if (this.fail) throw Error('storage failure'); this.rows.get(context).push(structuredClone(event)); }
  async read(context) { return structuredClone(this.rows.get(context) ?? []); }
  async contexts() { return [...this.rows.keys()]; }
}
async function pair(c = config) {
  const store = new MemoryStore();
  const a = await LiveMatch.create(c, store, 1, key(w1), c.mode === 'escrow' ? record : undefined);
  const b = await LiveMatch.create(c, store, 2, key(w2), c.mode === 'escrow' ? record : undefined);
  const r1 = await a.consent(), r2 = await b.consent();
  await a.receive(r2); await b.receive(r1);
  return { a, b, store };
}
function input(player, frame, inputMask = 0, prevSelfHash = ZERO32, prevOppHash = ZERO32, c = config) {
  const w = player === 1 ? w1 : w2;
  const hash = hashPacketFields(c.matchId, frame, player, inputMask, prevSelfHash, prevOppHash);
  return { type: 'INPUT', context: configHash(c), packet: { matchId: c.matchId, frame, player, inputMask, prevSelfHash, prevOppHash, hash, publicKey: w.signingKey.publicKey, signature: w.signingKey.sign(hash).serialized } };
}
test('signed readiness gates input, with strict schema/domain/slot/signer checks', async () => {
  const store = new MemoryStore(), a = await LiveMatch.create(config, store, 1, key(w1));
  await assert.rejects(a.receive(input(2, 1)), /readiness/);
  await assert.rejects(a.receive(null), /envelope/);
  await assert.rejects(a.receive({ ...input(2, 1), extra: true }), /envelope/);
  await assert.rejects(a.receive({ type: 'START_MATCH', matchId: config.matchId }), /envelope/);
  const r = { type: 'READY', slot: 2, context: a.context, signature: w1.signingKey.sign(lifecycleDigest(a.context, 2, 'READY')).serialized };
  await assert.rejects(a.receive(r), /signer/);
  await assert.rejects(a.receive({ ...r, slot: 1 }), /slot/);
  assert.equal(a.status, 'prepared');
});
test('duplicates are idempotent and reordered signed dependencies become usable in order', async () => {
  const { a, b } = await pair();
  const messages = await a.tick(0);
  assert.equal(messages.length, 2);
  await b.receive(messages[1]);
  await b.tick(0);
  assert.equal(b.snapshot().state.frame, 0);
  const request = await b.requestMissing();
  assert.equal(request.frame, 1);
  const retransmission = await a.receive(request);
  assert.deepEqual(retransmission, [messages[0]]);
  await b.receive(retransmission[0]); await b.receive(messages[0]);
  await b.tick(0);
  assert.equal(b.snapshot().state.frame, 1);
  assert.equal(b.snapshot().packets.filter(p => p.player === 1).length, 2);
  assert.equal(b.snapshot().history.filter(e => e.message?.type === 'INPUT' && e.message.packet.player === 1).length, 2);
});
test('late signed conflict is preserved, halts play, and survives reload without a forfeit', async () => {
  const { a, b, store } = await pair();
  const aa = await a.tick(0), bb = await b.tick(0);
  for (const p of aa) await b.receive(p);
  for (const p of bb) await a.receive(p);
  await a.tick(0);
  assert.equal(a.snapshot().state.frame, 1);
  await a.receive(input(2, 1, 1));
  assert.equal(a.status, 'conflict');
  assert.equal(a.snapshot().evidence.packets.filter(p => p.player === 2 && p.frame === 1).length, 2);
  assert.deepEqual(await a.tick(0), []);
  const recovered = await LiveMatch.recover(`${a.context}:1`, store);
  assert.equal(recovered.status, 'inspection');
  assert.equal(recovered.snapshot().evidence.packets.filter(p => p.player === 2 && p.frame === 1).length, 2);
  assert.equal(recovered.snapshot().settlementEligible, false);
});
test('disconnect pauses signing; reconnect retains committed packets and rejects old generations', async () => {
  const { a } = await pair();
  await a.tick(0);
  const token = a.attach();
  await a.transport(false, token);
  assert.equal(a.status, 'disconnected');
  assert.deepEqual(await a.tick(0, token), []);
  await assert.rejects(a.receive(input(2, 1), token - 1), /Stale/);
  await a.transport(true, token);
  assert.equal(a.status, 'running');
  assert.equal(a.retransmit().filter(m => m.type === 'INPUT').length, 2);
  assert.equal(a.snapshot().state.winner, null);
});
test('outgoing inputs are not returned until commit completes; storage failure stops authority', async () => {
  const { a, store } = await pair();
  let release; store.gate = new Promise(resolve => { release = resolve; });
  let done = false;
  const pending = a.tick(0).then(result => { done = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(done, false);
  assert.equal(a.snapshot().packets.length, 0);
  release(); await pending;
  store.gate = undefined; store.fail = true;
  await assert.rejects(a.receive(input(2, 1)), /storage failure/);
  assert.equal(a.status, 'storage-failed');
  assert.equal(a.snapshot().packets.filter(p => p.player === 2).length, 0);
  assert.deepEqual(await a.tick(0), []);
});
test('disconnect during commit cannot re-sign a frame with a different input', async () => {
  const { a, store } = await pair();
  let release; store.gate = new Promise(resolve => { release = resolve; });
  const pending = a.tick(1);
  await new Promise(resolve => setTimeout(resolve, 15));
  const token = a.attach();
  release(); await assert.rejects(pending, /Stale/);
  store.gate = undefined;
  await a.transport(true, token);
  await a.tick(2, token);
  assert.equal(a.retransmit().find(m => m.type === "INPUT" && m.packet.frame === 1).packet.inputMask, 1);
  const first = (await store.read(`${a.context}:1`)).filter(e => e.message?.packet?.frame === 1);
  assert.equal(new Set(first.map(e => e.message.packet.hash)).size, 1);
});
test('reload reconstructs evidence but cannot regain signing authority even with the old key', async () => {
  const { a, store } = await pair();
  await a.tick(0);
  const saved = JSON.stringify(await store.read(`${a.context}:1`));
  assert.equal(saved.includes(w1.privateKey), false);
  assert.equal(saved.includes('privateKey'), false);
  const recovered = await LiveMatch.recover(`${a.context}:1`, store);
  assert.equal(recovered.status, 'inspection');
  await assert.rejects(recovered.consent(), /authority/);
  assert.deepEqual(await recovered.tick(0), []);
  await assert.rejects(LiveMatch.create(config, store, 1, key(w1)), /Existing/);
});
test('practice consent cannot authorize escrow; independent record required', async () => {
  const c = { ...config, mode: 'escrow', authorization: auth };
  assert.notEqual(configHash(c), configHash(config));
  await assert.rejects(LiveMatch.create(c, new MemoryStore(), 1, key(w1)), /Independent/);
  const { a } = await pair(c);
  const practiceReady = { type: 'READY', slot: 2, context: configHash(config), signature: w2.signingKey.sign(lifecycleDigest(configHash(config), 2, 'READY')).serialized };
  await assert.rejects(a.receive(practiceReady), /lifecycle/);
  assert.equal(a.snapshot().settlementEligible, false);
});
test('discovery validates its exact runtime schema and signed identity', async () => {
  const h = await hello(key(w1), binding.genesis, 1, ZERO32);
  assert.deepEqual(verifyHello(h, ZERO32), h);
  assert.throws(() => verifyHello(h, binding.genesis), /Stale/);
  assert.throws(() => verifyHello({ ...h, slot: 2 }, ZERO32), /signature/);
  assert.throws(() => verifyHello({ ...h, privateKey: w1.privateKey }, ZERO32), /schema/);
});
test('stale readiness completion and malformed packet fields cannot change active lifecycle', async () => {
  const { a, b, store } = await pair();
  const before = a.snapshot().history.length;
  for (const packet of [
    { ...input(2, 1).packet, frame: 1.5 },
    { ...input(2, 1).packet, inputMask: 16 },
    { ...input(2, 1).packet, prevSelfHash: '0x00' },
    { ...input(2, 1).packet, privateKey: 'no' },
  ]) await assert.rejects(a.receive({ type: 'INPUT', context: a.context, packet }));
  await assert.rejects(a.receive(input(2, 99)), /window/);
  assert.equal(a.snapshot().history.length, before);
  const c = { ...config, matchId: '0x' + '12'.repeat(32) };
  const fresh = await LiveMatch.create(c, store, 1, key(w1));
  let release; store.gate = new Promise(resolve => { release = resolve; });
  const pending = fresh.consent();
  await new Promise(resolve => setTimeout(resolve, 10));
  fresh.close(); release();
  await assert.rejects(pending, /Stale/);
  assert.equal(fresh.status, 'closed');
  assert.equal(b.status, 'running');
});
test('escrow runtime schema rejects extra authorization material before persistence', async () => {
  const c = { ...config, mode: 'escrow', authorization: { ...auth, privateKey: w1.privateKey } };
  const store = new MemoryStore();
  await assert.rejects(LiveMatch.create(c, store, 1, key(w1), record), /schema/);
  assert.deepEqual(await store.contexts(), []);
});
test('duplicate verification completing after transport replacement cannot alter the live match', async () => {
  const { a } = await pair();
  const message = input(2, 1);
  await a.receive(message);
  const before = a.snapshot();
  const pending = a.receive(message);
  await Promise.resolve();
  const generation = a.attach();
  await assert.rejects(pending, /Stale/);
  assert.deepEqual(a.snapshot().packets, before.packets);
  assert.equal(a.status, 'disconnected');
  await a.transport(true, generation);
  assert.equal(a.status, 'running');
});
test('reconnect reconciles a conflict committed during transport replacement before resuming', async () => {
  const { a, store } = await pair();
  await a.receive(input(2, 1));
  let release; store.gate = new Promise(resolve => { release = resolve; });
  const pending = a.receive(input(2, 1, 1));
  await new Promise(resolve => setTimeout(resolve, 10));
  const generation = a.attach(); release();
  await assert.rejects(pending, /Stale/);
  store.gate = undefined;
  await a.transport(true, generation);
  assert.equal(a.status, 'conflict');
  assert.equal(a.snapshot().evidence.packets.length, 2);
  assert.deepEqual(await a.tick(0), []);
});
