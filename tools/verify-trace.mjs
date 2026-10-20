#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import "./register-types.mjs";
const { verifyExecutionTraceCommitment } = await import("../src/execution-trace.ts");
try {
  const [transcriptFile, commitmentFile] = process.argv.slice(2);
  if (!transcriptFile || !commitmentFile || process.argv.length !== 4) throw new Error("Usage: npm run verify-trace -- transcript.json commitment.json");
  const [transcript, commitment] = await Promise.all([transcriptFile, commitmentFile].map(async (file) => JSON.parse(await readFile(file, "utf8"))));
  const ok = await verifyExecutionTraceCommitment(transcript, commitment);
  console.log(JSON.stringify({ ok, settlementEligible: false }));
  process.exitCode = ok ? 0 : 1;
} catch (error) { console.error(error); process.exitCode = 1; }
