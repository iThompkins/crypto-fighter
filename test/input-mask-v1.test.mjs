import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createSessionWallet,
  hashFrameFields,
  hashJson,
  hashPacketFields,
  signDigest,
  ZERO32,
} from "../src/crypto.ts";
import { decodeInputMask, encodeInputMask, initialState, transition } from "../src/game.ts";
import { isValidV1InputMask, KNOWN_MASK } from "../src/input-mask.ts";
import { verifyTranscript as verifyBrowserRaw } from "../src/verifier.ts";
import {
  isValidV1InputMask as isValidCliInputMask,
  verifyTranscript as verifyCliRaw,
} from "../tools/verify-match.mjs";

// These one-frame fixtures test mask semantics in explicitly partial replay mode.
const verifyBrowserTranscript = (value) => verifyBrowserRaw(value, { allowPartial: true });
const verifyCliTranscript = (value) => verifyCliRaw(value, { allowPartial: true });

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(repoRoot, "test/fixtures/input-mask-v1.json");
const cliPath = join(repoRoot, "tools/verify-match.mjs");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

function runtimeValue(tag) {
  if (tag === "undefined") return undefined;
  if (tag === "nan") return Number.NaN;
  if (tag === "positiveInfinity") return Infinity;
  if (tag === "negativeInfinity") return -Infinity;
  if (tag === "bigint") return 1n;
  throw new Error(`unknown runtime tag: ${tag}`);
}

function parsedKind(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function assertExpectedValue(vector, value) {
  if (vector.expectedNegativeZero) {
    assert.ok(Object.is(value, -0), `${vector.name}: expected negative zero`);
    return;
  }
  if (vector.expectedParsedValue === "Infinity") {
    assert.equal(value, Infinity, vector.name);
    return;
  }
  if (vector.expectedParsedValue === "-Infinity") {
    assert.equal(value, -Infinity, vector.name);
    return;
  }
  if (vector.expectedParsedValue === "NaN") {
    assert.ok(Number.isNaN(value), vector.name);
    return;
  }
  if (vector.expectedParsedKind === "undefined") {
    assert.equal(value, undefined, vector.name);
    return;
  }
  if (vector.expectedParsedKind === "bigint") {
    assert.equal(value.toString(), vector.expectedParsedValue, vector.name);
    return;
  }
  assert.deepEqual(value, vector.expectedParsedValue, vector.name);
}

async function signedPacket(matchId, frame, player, inputMask, wallet) {
  const hash = hashPacketFields(matchId, frame, player, inputMask, ZERO32, ZERO32);
  return {
    matchId,
    frame,
    player,
    inputMask,
    prevSelfHash: ZERO32,
    prevOppHash: ZERO32,
    publicKey: wallet.publicKey,
    signature: await signDigest(wallet.privateKey, hash),
    hash,
  };
}

async function makeValidTranscript() {
  const matchId = `0x${"11".repeat(32)}`;
  const p1Wallet = await createSessionWallet();
  const p2Wallet = await createSessionWallet();
  const p1 = await signedPacket(matchId, 1, 1, 1, p1Wallet);
  const p2 = await signedPacket(matchId, 1, 2, 2, p2Wallet);
  const frameHash = hashFrameFields(matchId, 1, p1.inputMask, p2.inputMask, ZERO32);
  const state = transition(initialState(), p1.inputMask, p2.inputMask);
  return {
    transcript: {
      version: 1,
      matchId,
      rules: { fps: 30, roundFrames: 300, maxHp: 7, oneOutstandingPacket: true, inputDelay: 2 },
      players: {
        p1: { slot: 1, address: p1Wallet.address, publicKey: p1Wallet.publicKey },
        p2: { slot: 2, address: p2Wallet.address, publicKey: p2Wallet.publicKey },
      },
      packets: [p1, p2],
      canonicalFrames: [{
        matchId,
        frame: 1,
        p1InputMask: p1.inputMask,
        p2InputMask: p2.inputMask,
        prevFrameHash: ZERO32,
        frameHash,
      }],
      final: {
        frame: state.frame,
        frameHash,
        stateHash: hashJson(state),
        p1Hp: state.p1.hp,
        p2Hp: state.p2.hp,
        winner: state.winner,
        roundOver: state.roundOver,
      },
    },
    wallets: { 1: p1Wallet, 2: p2Wallet },
  };
}

async function resignPacketMask(transcript, packetIndex, inputMask, wallet) {
  const packet = transcript.packets[packetIndex];
  packet.inputMask = inputMask;
  packet.hash = hashPacketFields(
    packet.matchId,
    packet.frame,
    packet.player,
    packet.inputMask,
    packet.prevSelfHash,
    packet.prevOppHash,
  );
  packet.signature = await signDigest(wallet.privateKey, packet.hash);
}

test("golden parsed/runtime vectors have browser and CLI predicate parity", () => {
  for (const vector of fixture.vectors) {
    const value = "jsonText" in vector ? JSON.parse(vector.jsonText) : runtimeValue(vector.runtimeTag);
    assert.equal(parsedKind(value), vector.expectedParsedKind, `${vector.name}: parsed kind`);
    assertExpectedValue(vector, value);
    assert.equal(isValidV1InputMask(value), vector.validJsMask, `${vector.name}: browser predicate`);
    assert.equal(isValidCliInputMask(value), vector.validJsMask, `${vector.name}: CLI predicate`);

    if (vector.abiRepresentable) {
      const solidityDecision = (BigInt(vector.uintDecimal) & ~15n) === 0n;
      assert.equal(solidityDecision, vector.validJsMask, `${vector.name}: Solidity oracle`);
    } else {
      assert.equal("uintDecimal" in vector, false, `${vector.name}: non-ABI vector has no uint`);
    }
  }
});

test("non-JSON runtime spellings remain parse failures", () => {
  for (const jsonText of ["undefined", "NaN", "Infinity", "-Infinity", "1n"]) {
    assert.throws(() => JSON.parse(jsonText), SyntaxError, jsonText);
  }
});

test("all 16 known bitsets round-trip without assigning extra semantics", () => {
  for (let mask = 0; mask <= KNOWN_MASK; mask += 1) {
    const decoded = decodeInputMask(mask);
    assert.equal(encodeInputMask(decoded), mask);
    assert.equal(mask & ~KNOWN_MASK, 0);
  }
});

test("browser and CLI accept the same valid signed transcript", async () => {
  const { transcript } = await makeValidTranscript();
  const browser = await verifyBrowserTranscript(transcript);
  const cli = await verifyCliTranscript(transcript);
  assert.equal(browser.ok, true, browser.errors.join("\n"));
  assert.equal(cli.ok, true, cli.errors.join("\n"));
});

test("correctly signed mask 16 is rejected before signature verification", async () => {
  const { transcript, wallets } = await makeValidTranscript();
  await resignPacketMask(transcript, 0, 16, wallets[1]);
  const expected = ["invalid v1 input mask at packets[0].inputMask"];
  assert.deepEqual((await verifyBrowserTranscript(transcript)).errors, expected);
  assert.deepEqual((await verifyCliTranscript(transcript)).errors, expected);
});

test("preflight covers every mask location, including unwalked extras", async () => {
  const cases = [
    ["packet", (t) => { t.packets[0].inputMask = 16; }, "invalid v1 input mask at packets[0].inputMask"],
    ["canonical P1", (t) => { t.canonicalFrames[0].p1InputMask = 16; }, "invalid v1 input mask at canonicalFrames[0].p1InputMask"],
    ["canonical P2", (t) => { t.canonicalFrames[0].p2InputMask = 16; }, "invalid v1 input mask at canonicalFrames[0].p2InputMask"],
    ["extra packet", (t) => { t.packets.push({ inputMask: 16 }); }, "invalid v1 input mask at packets[2].inputMask"],
    ["extra canonical P1", (t) => { t.canonicalFrames.push({ ...t.canonicalFrames[0], frame: 99, p1InputMask: 16 }); }, "invalid v1 input mask at canonicalFrames[1].p1InputMask"],
    ["extra canonical P2", (t) => { t.canonicalFrames.push({ ...t.canonicalFrames[0], frame: 99, p2InputMask: 16 }); }, "invalid v1 input mask at canonicalFrames[1].p2InputMask"],
    ["missing packet mask", (t) => { delete t.packets[0].inputMask; }, "invalid v1 input mask at packets[0].inputMask"],
  ];

  for (const [name, mutate, error] of cases) {
    const { transcript } = await makeValidTranscript();
    mutate(transcript);
    const browser = await verifyBrowserTranscript(transcript);
    const cli = await verifyCliTranscript(transcript);
    assert.equal(browser.ok, false, name);
    assert.equal(cli.ok, false, name);
    assert.deepEqual(browser.errors, [error], name);
    assert.deepEqual(cli.errors, [error], name);
  }
});

test("preflight collects errors in canonical packet/P1/P2 scan order", async () => {
  const { transcript } = await makeValidTranscript();
  transcript.packets[0].inputMask = 16;
  delete transcript.packets[1].inputMask;
  transcript.canonicalFrames[0].p1InputMask = 17;
  transcript.canonicalFrames[0].p2InputMask = null;
  const expected = [
    "invalid v1 input mask at packets[0].inputMask",
    "invalid v1 input mask at packets[1].inputMask",
    "invalid v1 input mask at canonicalFrames[0].p1InputMask",
    "invalid v1 input mask at canonicalFrames[0].p2InputMask",
  ];
  assert.deepEqual((await verifyBrowserTranscript(transcript)).errors, expected);
  assert.deepEqual((await verifyCliTranscript(transcript)).errors, expected);
});

test("CLI process exits 0 for valid and 1 for each invalid mask location", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "crypto-fighter-mask-v1-"));
  const { transcript } = await makeValidTranscript();
  const variants = [
    ["valid", () => {}, 0, null],
    ["packet", (t) => { t.packets[0].inputMask = 16; }, 1, "packets[0].inputMask"],
    ["canonical-p1", (t) => { t.canonicalFrames[0].p1InputMask = 16; }, 1, "canonicalFrames[0].p1InputMask"],
    ["canonical-p2", (t) => { t.canonicalFrames[0].p2InputMask = 16; }, 1, "canonicalFrames[0].p2InputMask"],
  ];

  for (const [name, mutate, expectedStatus, expectedLocation] of variants) {
    const candidate = structuredClone(transcript);
    mutate(candidate);
    const transcriptPath = join(tempDir, `${name}.json`);
    await writeFile(transcriptPath, JSON.stringify(candidate));
    const result = spawnSync(process.execPath, [cliPath, transcriptPath, "--allow-partial"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, expectedStatus, `${name}: ${result.stderr}`);
    if (expectedLocation) assert.match(result.stdout, new RegExp(expectedLocation.replaceAll("[", "\\[").replaceAll("]", "\\]")));
  }
});
