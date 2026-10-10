import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auth, record, w1, w2 } from './fixtures/genesis.mjs';
import { configHash, lifecycleDigest } from '../src/live-protocol.ts';
import { LiveMatch } from '../src/live-match.ts';
import { canonicalJson, reconstructEvidence } from '../src/evidence-archive.ts';
import { buildEvidenceBundle, loadEvidenceDefense, verifyEvidenceBundle } from '../src/evidence-trace.ts';
import { buildExecutionTrace, hashCheckpoint, verifyTraceOpening } from '../src/execution-trace.ts';
import { hashPacketFields, ZERO32 } from '../src/crypto.ts';
import { INPUT_DELAY, transition } from '../src/game.ts';
import { hashTraceState } from '../src/protocol.ts';
import { prepareTraceClaim, prepareTraceChallenge, prepareMidpointOpening, prepareAdjudicationWitness } from '../src/onchain-dispute.ts';

const directory = await mkdtemp(join(tmpdir(), 'crypto-fighter-evidence-'));
const sourceFile = join(directory, 'source.json');
execFileSync(process.execPath, ['tools/make-transcript.mjs', sourceFile]);
const source = JSON.parse(await readFile(sourceFile, 'utf8'));
function archive(mode = 'practice') {
  const config = { version: 1, mode, matchId: source.matchId, rulesHash: source.rulesHash, p1PublicKey: w1.signingKey.publicKey, p2PublicKey: w2.signingKey.publicKey, ...(mode === 'escrow' ? { authorization: auth } : {}) };
  const context = configHash(config);
  const ready = [w1, w2].map((w, i) => ({ type: 'READY', context, slot: i + 1, signature: w.signingKey.sign(lifecycleDigest(context, i + 1, 'READY')).serialized }));
  return { format: 'phase-b-journal-v1', journal: [
    { kind: 'genesis', config, localSlot: 1, ...(mode === 'escrow' ? { record } : {}) },
    ...ready.map(message => ({ kind: 'message', message })),
    ...source.packets.map(packet => ({ kind: 'message', message: { type: 'INPUT', context, packet } })),
  ] };
}
const original = archive();
const baseline = await buildEvidenceBundle(original);
function extra(player, frame, inputMask, prevSelfHash, prevOppHash, a = original) {
  const w = player === 1 ? w1 : w2;
  const matchId = a.journal[0].config.matchId;
  const hash = hashPacketFields(matchId, frame, player, inputMask, prevSelfHash, prevOppHash);
  return { kind: 'message', message: { type: 'INPUT', context: configHash(a.journal[0].config), packet: {
    matchId, frame, player, inputMask, prevSelfHash, prevOppHash, hash, publicKey: w.signingKey.publicKey, signature: w.signingKey.sign(hash).serialized,
  } } };
}
const packet = (player, frame) => source.packets.find(p => p.player === player && p.frame === frame);

test('journal-first reconstruction reproduces canonical transcript, states and existing Merkle bytes', async () => {
  assert.equal(baseline.reconstruction.status, 'complete');
  assert.equal(canonicalJson(baseline.reconstruction.transcript), canonicalJson(source));
  assert.equal(baseline.trace.root, (await buildExecutionTrace(source)).root);
  assert.equal(hashTraceState(baseline.reconstruction.states.at(-1)), source.final.stateHash);
  assert.equal(baseline.settlementEligible, false);
});
test('duplicates, buffered reordering, local slot and observations do not change canonical outputs', async () => {
  const a = structuredClone(original);
  a.journal = [a.journal[0], ...a.journal.slice(1).reverse(), ...a.journal.slice(1, 8)];
  a.journal[0].localSlot = 2;
  a.journal.push({ kind: 'observation', observation: { kind: 'disconnect', localTime: 100, frame: 20 } });
  const b = await buildEvidenceBundle(a);
  for (const field of ['transcriptHash', 'statesHash', 'trace', 'commitment']) assert.equal(canonicalJson(b[field]), canonicalJson(baseline[field]));
  assert.equal(b.reconstruction.evidenceHash, baseline.reconstruction.evidenceHash);
  assert.notEqual(b.reconstruction.journalHash, baseline.reconstruction.journalHash);
});
test('recovered evidence produces byte-identical canonical bundle without a signing key', async () => {
  const stored = structuredClone(original.journal);
  const recovered = await LiveMatch.recover(`${baseline.reconstruction.context}:1`, { read: async () => stored });
  assert.equal(recovered.status, 'inspection');
  const rebuilt = await buildEvidenceBundle(await recovered.exportEvidence());
  assert.equal(canonicalJson(rebuilt), canonicalJson(baseline));
  await assert.rejects(recovered.consent(), /authority/);
});
test('complete gameplay, incomplete evidence and missing readiness remain distinguishable', async () => {
  const gap = structuredClone(original);
  gap.journal = gap.journal.filter(e => e.message?.packet?.frame !== 10);
  const result = await buildEvidenceBundle(gap);
  assert.equal(result.reconstruction.status, 'incomplete');
  assert.equal(result.reconstruction.transcript.final.frame, 9);
  assert.equal(result.trace, null);
  assert(result.reconstruction.missing.some(m => m.frame === 10));
  const noReady = structuredClone(original);
  noReady.journal.splice(1, 1);
  const readiness = await reconstructEvidence(noReady);
  assert.deepEqual(readiness.missingReadiness, [1]);
  assert.equal(readiness.status, 'incomplete');
  assert.equal(readiness.transcript.final.frame, 0);
});
test('unused tail is preserved but cannot alter executed transcript or trace', async () => {
  const a = structuredClone(original), f = source.final.frame + 1;
  a.journal.push(extra(1, f, 0, packet(1, f - 1).hash, packet(2, f - INPUT_DELAY).hash));
  const b = await buildEvidenceBundle(a);
  assert.equal(b.reconstruction.status, 'complete');
  assert.equal(b.reconstruction.signedPackets.length, source.packets.length + 1);
  assert.equal(b.transcriptHash, baseline.transcriptHash);
  assert.equal(b.trace.root, baseline.trace.root);
  const orphan = structuredClone(original);
  orphan.journal.push(extra(1, f + 1, 0, ZERO32, packet(2, f + 1 - INPUT_DELAY).hash));
  const incomplete = await buildEvidenceBundle(orphan);
  assert.equal(incomplete.reconstruction.gameplayComplete, true);
  assert.equal(incomplete.reconstruction.status, 'incomplete');
  assert.equal(incomplete.trace, null);
});
test('late executed and delayed-tail equivocation cannot be filtered into a branch commitment', async () => {
  for (const tail of [false, true]) {
    const a = structuredClone(original), f = tail ? source.final.frame + 1 : 1;
    const self = tail ? packet(1, f - 1).hash : ZERO32, other = tail ? packet(2, f - INPUT_DELAY).hash : ZERO32;
    if (tail) a.journal.push(extra(1, f, 0, self, other));
    a.journal.push(extra(1, f, 1, self, other));
    const b = await buildEvidenceBundle(a);
    assert.equal(b.reconstruction.status, 'conflict');
    assert.equal(b.reconstruction.conflicts.length, 1);
    assert.equal(b.reconstruction.transcript, null);
    assert.equal(b.trace, null);
    await assert.rejects(loadEvidenceDefense(b), /uncontested/);
    assert.equal(await verifyEvidenceBundle({ ...baseline, archive: a }), false);
  }
});
test('authenticated chain mismatch does not silently disappear from the artifact', async () => {
  const a = structuredClone(original);
  a.journal = a.journal.filter(e => !(e.message?.packet?.frame === 2 && e.message.packet.player === 1));
  a.journal.push(extra(1, 2, 0, ZERO32, ZERO32));
  const b = await buildEvidenceBundle(a);
  assert.equal(b.reconstruction.status, 'invalid-chain');
  assert.equal(b.trace, null);
  assert.equal(b.reconstruction.transcript, null);
});
test('mode-bound readiness prevents practice promotion; historical authority is explicit', async () => {
  const a = archive('escrow');
  const historical = await buildEvidenceBundle(a);
  const trusted = await buildEvidenceBundle(a, record);
  assert.equal(historical.authority, 'historical-inspection');
  assert.equal(historical.trace.genesisAuthorized, undefined);
  assert.equal(trusted.authority, 'independent-record');
  assert.equal(trusted.trace.genesisAuthorized, true);
  assert.equal(trusted.trace.root, historical.trace.root);
  assert.notEqual(trusted.trace.root, baseline.trace.root);
  assert.equal(await verifyEvidenceBundle(trusted), false);
  assert.equal(await verifyEvidenceBundle(trusted, record), true);
  await assert.rejects(buildEvidenceBundle(original, record), /Practice/);
  await assert.rejects(buildEvidenceBundle(a, { ...record, authorized: false }), /Independent/);
  a.journal[1] = original.journal[1];
  await assert.rejects(buildEvidenceBundle(a), /domain/);
});
test('independently authorized bundles produce contract-shaped claim, midpoint and step witnesses', async () => {
  const trusted = await buildEvidenceBundle(archive('escrow'), record);
  const historical = await buildEvidenceBundle(archive('escrow'));
  const claim = await prepareTraceClaim(trusted, record);
  const challenge = await prepareTraceChallenge(trusted, record);
  const midpoint = await prepareMidpointOpening(trusted, 45, record);
  assert.equal(claim.root, trusted.trace.root);
  assert.deepEqual(claim.genesis.checkpoint, trusted.trace.checkpoints[0]);
  assert.equal(claim.genesis.siblings.length, 9);
  assert.equal(claim.endpoint.checkpoint.stateHash, trusted.trace.checkpoints[300].stateHash);
  assert.equal(claim.terminalState.frame, trusted.trace.terminalFrame);
  assert.equal(claim.archivePublication.journalHash, trusted.reconstruction.journalHash);
  assert.equal(challenge.root, claim.root);
  assert.equal(midpoint.index, 45);
  assert.equal(midpoint.opening.siblings.length, 9);
  const defense = await loadEvidenceDefense(trusted, record);
  const comparison = { contextHash:trusted.trace.contextHash, claimantRoot:trusted.trace.root, challengerRoot:trusted.trace.root,
    claimantBefore:defense.opening(0), claimantAfter:defense.opening(1), challengerAfter:defense.opening(1) };
  const witness = await prepareAdjudicationWitness(trusted, 1, comparison, record);
  assert.equal(witness.expectedVerdict, 'claimant');
  assert.equal(witness.beforeState.frame, 0);
  assert.equal(witness.p1.signature, source.packets[0].signature);
  assert.equal(witness.canonicalPost, hashCheckpoint(trusted.trace.checkpoints[1]));
  for (const rejected of [
    () => prepareTraceClaim(historical, record),
    () => prepareTraceClaim(trusted),
    () => prepareAdjudicationWitness(trusted, 1, {...comparison, contextHash:ZERO32}, record),
    () => { const bad=structuredClone(comparison); bad.claimantAfter.siblings.pop(); return prepareAdjudicationWitness(trusted,1,bad,record); },
  ]) await assert.rejects(rejected(), /record|context|opening/i);
});
test('defense package regenerates every opening and execution/absorbing step without peer or UI', async () => {
  const defense = await loadEvidenceDefense(baseline);
  for (let i = 0; i <= 300; i++) assert(verifyTraceOpening(baseline.trace.root, baseline.trace.contextHash, defense.opening(i)));
  for (let i = 1; i <= 300; i++) {
    const step = defense.step(i);
    assert.equal(step.before.index, i - 1); assert.equal(step.after.index, i);
    if (i <= source.final.frame) {
      assert.equal(step.kind, 'execution');
      assert.deepEqual(transition(step.preState, step.p1.inputMask, step.p2.inputMask), step.postState);
      assert.equal(step.p1.prevSelfHash, step.before.checkpoint.p1Head);
      assert.equal(step.p1.prevOppHash, step.before.checkpoint.p2PreviousHead);
    } else {
      assert.equal(step.kind, 'terminal-absorption');
      assert.equal(step.terminalState.roundOver, true);
      assert.deepEqual(step.before.checkpoint, step.after.checkpoint);
    }
  }
  assert.throws(() => defense.step(0));
});
test('imported derived artifacts and untrusted schema changes are rejected', async () => {
  for (const mutate of [
    b => { b.trace.root = ZERO32; },
    b => { b.reconstruction.states[0].p1.hp = 1; },
    b => { b.endpoints.genesis.siblings[0] = ZERO32; },
    b => { b.authority = 'independent-record'; },
  ]) { const b = structuredClone(baseline); mutate(b); assert.equal(await verifyEvidenceBundle(b), false); }
  const a = structuredClone(original);
  a.journal.push({ kind: 'message', message: { ...a.journal[1].message, type: 'RESET_MATCH' } });
  await assert.rejects(reconstructEvidence(a), /schema/);
  await assert.rejects(reconstructEvidence(source), /journal/);
});
test('snapshot before asynchronous verification prevents caller mutation from changing committed outputs', async () => {
  const a = structuredClone(original);
  const promise = buildEvidenceBundle(a);
  a.journal[3].message.packet.inputMask = 15;
  assert.equal(canonicalJson(await promise), canonicalJson(baseline));
});
test('offline CLI builds byte-identical bundles and verifies/exports isolated-step artifacts', async () => {
  const archiveFile = join(directory, 'archive.json'), bundleFile = join(directory, 'bundle.json');
  await writeFile(archiveFile, canonicalJson(original));
  const stdout = execFileSync(process.execPath, ['tools/evidence-trace.mjs', 'build', archiveFile], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(stdout.trim(), canonicalJson(baseline));
  await writeFile(bundleFile, stdout);
  const check = JSON.parse(execFileSync(process.execPath, ['tools/evidence-trace.mjs', 'verify', bundleFile], { encoding: 'utf8' }));
  assert.deepEqual(check, { ok: true, complete: true, settlementEligible: false });
  const step = JSON.parse(execFileSync(process.execPath, ['tools/evidence-trace.mjs', 'step', bundleFile, '1'], { encoding: 'utf8' }));
  assert.equal(step.kind, 'execution');
  assert.equal(step.preState.frame, 0);
  const bad = structuredClone(baseline); bad.trace.root = ZERO32;
  await writeFile(bundleFile, canonicalJson(bad));
  assert.equal(spawnSync(process.execPath, ['tools/evidence-trace.mjs', 'verify', bundleFile]).status, 1);
});
test('authenticated over-horizon tails remain exportable inspection evidence', async () => {
  const a = structuredClone(original);
  const history = new Map(source.packets.map(p => [`${p.player}:${p.frame}`, p.hash]));
  for (let frame = source.final.frame + 1; frame <= source.final.frame + INPUT_DELAY + 1; frame++) {
    for (const player of [1, 2]) {
      const row = extra(player, frame, 0, history.get(`${player}:${frame - 1}`), history.get(`${player === 1 ? 2 : 1}:${frame - INPUT_DELAY}`));
      a.journal.push(row); history.set(`${player}:${frame}`, row.message.packet.hash);
    }
  }
  const b = await buildEvidenceBundle(a);
  assert.equal(b.reconstruction.status, 'outside-horizon');
  assert.equal(b.reconstruction.gameplayComplete, true);
  assert.equal(b.reconstruction.outOfHorizon.length, 2);
  assert.equal(b.trace, null);
  assert.equal(canonicalJson(b.archive), canonicalJson(a));
  assert.equal(await verifyEvidenceBundle(b), true);
});
