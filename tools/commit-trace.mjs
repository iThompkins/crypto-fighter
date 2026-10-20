#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import "./register-types.mjs";
const { buildExecutionTrace, openTrace } = await import("../src/execution-trace.ts");
try {
  const [file, indexText] = process.argv.slice(2);
  if (!file || process.argv.length > 4) throw new Error("Usage: npm run commit-trace -- transcript.json [checkpoint-index]");
  const trace = await buildExecutionTrace(JSON.parse(await readFile(file, "utf8")));
  const { levels, checkpoints, ...commitment } = trace;
  void levels; void checkpoints;
  const index = indexText === undefined ? trace.terminalFrame : Number(indexText);
  console.log(JSON.stringify({ ...commitment, opening: openTrace(trace, index) }, null, 2));
} catch (error) { console.error(error); process.exitCode = 1; }
