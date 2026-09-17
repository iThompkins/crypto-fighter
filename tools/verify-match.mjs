#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import "./register-types.mjs";

// Run the exact browser transition/verification implementation under Node.
const verifier = await import("../src/verifier.ts");
const masks = await import("../src/input-mask.ts");
export const verifyTranscript = verifier.verifyTranscript;
export const isValidV1InputMask = masks.isValidV1InputMask;

async function main() {
  const args = process.argv.slice(2);
  const allowPartial = args.includes("--allow-partial");
  const files = args.filter((arg) => arg !== "--allow-partial");
  if (files.length !== 1) {
    console.error("Usage: npm run verify-match -- path/to/transcript.json [--allow-partial]");
    process.exitCode = 2;
    return;
  }
  const result = await verifyTranscript(JSON.parse(await readFile(files[0], "utf8")), { allowPartial });
  // State samples are available in the browser replay; keep CLI reports compact.
  const { states, ...report } = result;
  void states;
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
