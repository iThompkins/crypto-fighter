import assert from "node:assert/strict";
import test from "node:test";
import { Wallet, Signature, concat, toBeHex } from "ethers";
import { createGenesisSession, hashGenesisBinding, verifyGenesisAuthorization } from "../src/genesis.ts";
import { verifyPacket, ZERO32 } from "../src/crypto.ts";

import { w1, binding, record, auth } from "./fixtures/genesis.mjs";
const sessionWallet = (w) => ({ address: w.address, publicKey: w.signingKey.publicKey, privateKey: w.privateKey });

test("authorization is not its own authority and cannot be relabeled across domains", () => {
  assert.equal(verifyGenesisAuthorization(auth, record), true);
  assert.equal(verifyGenesisAuthorization(auth, { ...record, authorized: false }), false);
  assert.equal(verifyGenesisAuthorization(auth, { ...record, registrationChallengeId: "2" }), false);
  for (const changes of [
    { chainId: "1" }, { arena: "0x" + "ab".repeat(20) }, { genesis: "0x" + "12".repeat(32) },
    { challengeId: "2" }, { stake: "1001" }, { responseWindow: "86401" },
    { p1: "0x" + "bd".repeat(20) }, { p2Session: new Wallet("0x" + "3".padStart(64, "0")).address },
  ]) {
    const other = { ...binding, ...changes };
    assert.notEqual(hashGenesisBinding(other), hashGenesisBinding(binding));
    assert.equal(verifyGenesisAuthorization({ ...auth, binding: other }, { ...record, binding: other }), false);
  }
});

test("one session adopts one binding; compact moves require activation and cannot equivocate", async () => {
  const session = createGenesisSession(sessionWallet(w1), 1, binding.p1);
  await assert.rejects(session.signMove(1, 0, ZERO32, ZERO32), /activate genesis/);
  await assert.rejects(session.authorize({ ...record, binding: { ...binding, p1: binding.arena } }), /unexpected main-wallet participant/);
  const signature = await session.authorize({ ...record, authorized: false });
  assert.equal(signature, auth.p1Signature);
  assert.throws(() => session.activate(auth, { ...record, authorized: false }), /not authoritatively authorized/);
  session.activate(auth, record);
  const packet = await session.signMove(1, 0, ZERO32, ZERO32);
  assert.equal(packet.matchId, binding.genesis);
  assert.equal(await verifyPacket(packet), true);
  const sig = Signature.from(packet.signature);
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const high = concat([sig.r, toBeHex(order - BigInt(sig.s), 32), toBeHex(sig.v === 27 ? 28 : 27, 1)]);
  assert.equal(await verifyPacket({ ...packet, signature: high }), false);
  assert.deepEqual(Object.keys(packet).sort(), ["frame", "hash", "inputMask", "matchId", "player", "prevOppHash", "prevSelfHash", "publicKey", "signature"].sort());
  assert.deepEqual(await session.signMove(1, 0, ZERO32, ZERO32), packet);
  await assert.rejects(session.signMove(1, 4, ZERO32, ZERO32), /conflicting move/);
  await assert.rejects(session.signMove(3, 0, packet.hash, ZERO32), /continue the adopted self chain/);
  await assert.rejects(session.authorize({ ...record, binding: { ...binding, arena: "0x" + "dd".repeat(20) } }), /already adopted/);
  const p2 = await session.signMove(2, 4, packet.hash, ZERO32);
  assert.equal(await verifyPacket(p2), true);
});

test("binding validation rejects noncanonical identifiers, rules and numeric encodings", () => {
  for (const changes of [{ chainId: "031337" }, { stake: "1e3" }, { genesis: ZERO32 }, { rulesHash: ZERO32 }, { p2: binding.p1 }, { p2Session: binding.p1Session }, { responseWindow: "1" }]) {
    assert.throws(() => hashGenesisBinding({ ...binding, ...changes }));
  }
});

