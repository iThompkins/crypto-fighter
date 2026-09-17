import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { CANONICAL_PROTOCOL_VERSION, CANONICAL_RULES_HASH, CANONICAL_V1_RULES } from "../src/protocol.ts";
import { makeMatchId, hashPacketFields, ZERO32 } from "../src/crypto.ts";

test("canonical fingerprint matches the contract and fixed v1 metadata", async () => {
  assert.equal(CANONICAL_PROTOCOL_VERSION, 1);
  assert.equal(CANONICAL_RULES_HASH, "0x1ae89ee81810335d8b8b2ee8d7e9237fef05704a9fae836f3e748fcafdca65cc");
  const contract = await readFile(new URL("../contracts/CryptoFighterArena.sol", import.meta.url), "utf8");
  assert.match(contract, new RegExp(`CANONICAL_RULES_HASH\\s*=\\s*${CANONICAL_RULES_HASH}`));
  assert.ok(Object.isFrozen(CANONICAL_V1_RULES));
  assert.throws(() => { CANONICAL_V1_RULES.maxHp = 100; }, TypeError);
});

test("live genesis identifiers are fresh and seed distinct first-move chains", () => {
  const ids = Array.from({ length: 32 }, () => makeMatchId());
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^0x[0-9a-f]{64}$/);
  const heads = ids.map((id) => hashPacketFields(id, 1, 1, 0, ZERO32, ZERO32));
  assert.equal(new Set(heads).size, ids.length);
});
