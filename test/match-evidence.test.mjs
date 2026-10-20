import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatchEvidence } from '../src/match-evidence.ts';
import { hashPacketFields, ZERO32 } from '../src/crypto.ts';
import { auth, record, w1, w2, binding } from './fixtures/genesis.mjs';
function packet(player = 1, frame = 1, inputMask = 0, prevSelfHash = ZERO32, prevOppHash = ZERO32) {
  const wallet = player === 1 ? w1 : w2;
  const hash = hashPacketFields(binding.genesis, frame, player, inputMask, prevSelfHash, prevOppHash);
  return { matchId: binding.genesis, player, frame, inputMask, prevSelfHash, prevOppHash, hash,
    publicKey: wallet.signingKey.publicKey, signature: wallet.signingKey.sign(hash).serialized };
}
test('requires authoritative authorization and pins immutable evidence', async () => {
  assert.throws(() => createMatchEvidence(auth, { ...record, authorized: false }));
  const evidence = createMatchEvidence(auth, record);
  const p = packet();
  const pending = evidence.receive(p);
  p.inputMask = 1;
  assert.equal((await pending).kind, 'authenticated-packet');
  const exported = evidence.export();
  exported.packets[0].inputMask = 2;
  assert.equal(evidence.export().packets[0].inputMask, 0);
  assert.equal(evidence.export().settlementEligible, false);
});
test('retains delayed equivocation while duplicates are idempotent', async () => {
  const evidence = createMatchEvidence(auth, record);
  await evidence.receive(packet());
  assert.equal((await evidence.receive(packet())).duplicate, true);
  const result = await evidence.receive(packet(1, 1, 1));
  assert.equal(result.kind, 'equivocation');
  assert.equal(result.packets.length, 2);
  assert.equal(evidence.export().packets.length, 2);
});
test('forgery cannot manufacture attributed equivocation', async () => {
  const evidence = createMatchEvidence(auth, record);
  await evidence.receive(packet());
  const forged = packet(1, 1, 1);
  forged.signature = w2.signingKey.sign(forged.hash).serialized;
  assert.equal((await evidence.receive(forged)).kind, 'unattributed-rejection');
  assert.equal((await evidence.receive(null)).kind, 'unattributed-rejection');
  assert.equal(evidence.export().packets.length, 1);
});
test('missing packets and disconnect observations do not establish a protocol fault', async () => {
  const evidence = createMatchEvidence(auth, record);
  const first = packet();
  await evidence.receive(packet(1, 2, 0, first.hash));
  assert.equal(evidence.chainEvidence(1, 2).kind, 'missing-dependency');
  evidence.observe('disconnect', 100, 0);
  evidence.observe('stall', 200, 0);
  await evidence.receive(first);
  assert.equal(evidence.chainEvidence(1, 2).kind, 'ready');
  assert.equal(evidence.export().observations.length, 2);
  assert.equal(evidence.export().settlementEligible, false);
});
test('chain contradictions retain signed supporting evidence', async () => {
  const evidence = createMatchEvidence(auth, record);
  await evidence.receive(packet());
  await evidence.receive(packet(1, 2));
  const result = evidence.chainEvidence(1, 2);
  assert.equal(result.kind, 'chain-mismatch');
  assert.equal(result.chain, 'self');
  assert.equal(result.dependency.frame, 1);
});
test('concurrent durable admissions retain both conflicting signed statements', async () => {
  const evidence = createMatchEvidence(auth, record);
  const commit = async () => { await new Promise(resolve => setTimeout(resolve, 5)); };
  const results = await Promise.all([evidence.receive(packet(), commit), evidence.receive(packet(1, 1, 1), commit)]);
  assert.equal(results[1].kind, 'equivocation');
  assert.equal(evidence.export().packets.length, 2);
  assert.equal(evidence.validatedPackets().length, 0);
});
