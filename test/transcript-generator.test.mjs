import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyTranscript } from "../src/verifier.ts";

test("fixture generation is byte-for-byte repeatable and reaches a verified terminal winner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crypto-fighter-generator-"));
  const files = [join(dir, "a.json"), join(dir, "b.json")];
  for (const file of files) execFileSync(process.execPath, ["tools/make-transcript.mjs", file]);
  const [a, b] = await Promise.all(files.map((file) => readFile(file, "utf8")));
  assert.equal(a, b);
  const result = await verifyTranscript(JSON.parse(a));
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.replay.winner, "P1");
  assert.equal(result.replay.roundOver, true);
  assert.equal(result.replay.frame, 91);
});
