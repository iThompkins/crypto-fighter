#!/usr/bin/env node
// Evidence-first offline reconstruction. Embedded activation records are historical
// inspection data; this command never promotes a JSON record to fresh chain authority.
import { readFile, stat } from 'node:fs/promises';
import './register-types.mjs';
const { buildEvidenceBundle, loadEvidenceDefense, verifyEvidenceBundle } = await import('../src/evidence-trace.ts');
const { canonicalJson, MAX_EVIDENCE_BYTES } = await import('../src/evidence-archive.ts');
async function readJson(file) {
  if ((await stat(file)).size > 4 * MAX_EVIDENCE_BYTES) throw new Error('Artifact exceeds file limit');
  return JSON.parse(await readFile(file, 'utf8'));
}
try {
  const [action, file, frameText] = process.argv.slice(2);
  if (!file || !['build', 'verify', 'step'].includes(action) || process.argv.length > 5 || (action !== 'step' && frameText !== undefined)) throw new Error('Usage: npm run evidence-trace -- build|verify|step archive-or-bundle.json [step-frame]');
  const input = await readJson(file);
  if (action === 'build') {
    const archive = input?.format === 'phase-c-dispute-bundle-v1' ? input.archive : input;
    console.log(canonicalJson(await buildEvidenceBundle(archive)));
  } else if (action === 'verify') {
    const ok = await verifyEvidenceBundle(input);
    console.log(canonicalJson({ ok, complete: ok && input.reconstruction.status === 'complete', settlementEligible: false }));
    process.exitCode = ok ? 0 : 1;
  } else {
    if (frameText === undefined) throw new Error('Step frame required');
    const defense = await loadEvidenceDefense(input);
    console.log(canonicalJson(defense.step(Number(frameText))));
  }
} catch (error) { console.error(String(error)); process.exitCode = 1; }
