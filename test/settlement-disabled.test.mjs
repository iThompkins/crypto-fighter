import assert from "node:assert/strict";
import test from "node:test";
import { arena } from "../src/chain.ts";

test("browser settlement refuses to construct a transaction client", () => {
  const signer = new Proxy({}, { get() { throw new Error("signer accessed"); } });
  assert.throws(() => arena("0x" + "11".repeat(20), signer), /Settlement transactions are disabled/);
});
