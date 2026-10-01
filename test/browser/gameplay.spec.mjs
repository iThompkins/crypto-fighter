import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { auth, record } from "../fixtures/genesis.mjs";

async function developerMode(page) {
  await page.getByRole("button", { name: "Regular mode", exact: true }).click();
}

async function exportTranscript(page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download JSON", exact: true }).click();
  const download = await downloadPromise;
  return JSON.parse(await readFile(await download.path(), "utf8"));
}

async function browserVerify(page, transcript) {
  return page.evaluate(async (value) => {
    const { verifyTranscript } = await import("/src/verifier.ts");
    return verifyTranscript(value);
  }, transcript);
}

test("generated terminal replay agrees in browser and CLI; settlement stays disabled", async ({ page }, testInfo) => {
  const file = testInfo.outputPath("terminal.json");
  execFileSync(process.execPath, ["tools/make-transcript.mjs", file]);
  const transcript = JSON.parse(await readFile(file, "utf8"));
  const cli = JSON.parse(execFileSync(process.execPath, ["tools/verify-match.mjs", file], { encoding: "utf8" }));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  for (const name of ["Challenge (P1)", "Join (P2)", "Claim Result", "Finalize"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  }
  await developerMode(page);
  await expect(page.getByRole("heading", { name: "Dispute witness preparation", exact: true })).toBeVisible();
  for (const name of ["Prepare claim", "Prepare midpoint", "Prepare isolated step"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await page.getByPlaceholder("Paste transcript JSON here...").fill(JSON.stringify(transcript));
  await page.getByRole("button", { name: "Verify + Load", exact: true }).click();
  await expect(page.getByText(/Verifier: ok/)).toBeVisible();
  const browser = await browserVerify(page, transcript);
  expect(browser.ok).toBe(true);
  expect(browser.replay).toEqual(cli.replay);
  expect(browser.replay.winner).toBe("P1");
  expect(browser.replay.roundOver).toBe(true);
  expect(transcript.version).toBe(2);
  // Verify actual CSS conversion at genesis and during an active attack.
  for (const frame of [0, 80]) {
    await page.locator('input[type="range"]').fill(String(frame));
    const expectedState = browser.states[frame];
    const geometry = await page.evaluate(() => {
      const arena = document.querySelector('[aria-label="Game arena"]');
      const rect = label => {
        const style = document.querySelector(`[aria-label="${label}"]`).style;
        return ['left','top','width','height'].map(k => parseFloat(style[k]));
      };
      return { scale: parseFloat(arena.style.width)/720, p1: rect('Player 1 fighter'), p2: rect('Player 2 fighter'), attack: document.querySelector('[aria-label="Player 1 attack"]') ? rect('Player 1 attack') : null };
    });
    for (const slot of ['p1','p2']) {
      const f = expectedState[slot];
      const expected = [f.x/256,f.y/256,28,56];
      geometry[slot].forEach((v,i) => expect(v/geometry.scale).toBeCloseTo(expected[i],3));
    }
    if (frame === 80) {
      expect(geometry.attack).not.toBeNull();
      const f=expectedState.p1;
      [f.x/256+28,f.y/256+21,40,14].forEach((v,i)=>expect(geometry.attack[i]/geometry.scale).toBeCloseTo(v,3));
    }
  }

  const traceCli = JSON.parse(execFileSync(process.execPath, ["tools/commit-trace.mjs", file, "90"], { encoding: "utf8" }));
  const traceBrowser = await page.evaluate(async (value) => {
    const { buildExecutionTrace, openTrace, verifyTraceOpening } = await import("/src/execution-trace.ts");
    const trace = await buildExecutionTrace(value);
    const opening = openTrace(trace, 90);
    return { root: trace.root, contextHash: trace.contextHash, opening, valid: verifyTraceOpening(trace.root, trace.contextHash, opening) };
  }, transcript);
  expect(traceBrowser.valid).toBe(true);
  expect(traceBrowser.root).toBe(traceCli.root);
  expect(traceBrowser.contextHash).toBe(traceCli.contextHash);
  expect(traceBrowser.opening).toEqual(traceCli.opening);
  // Fixture authority here exercises browser crypto; hh/test/genesis.cjs
  // separately verifies the record against an actual activated EVM challenge.
  const authorizedBrowser = await page.evaluate(async ({ value, authorization, authoritative }) => {
    const { buildAuthorizedExecutionTrace } = await import("/src/execution-trace.ts");
    return buildAuthorizedExecutionTrace(value, authorization, authoritative);
  }, { value: transcript, authorization: auth, authoritative: record });
  expect(authorizedBrowser.genesisAuthorized).toBe(true);
  expect(authorizedBrowser.genesis).toBe(transcript.matchId);
  expect(authorizedBrowser.settlementEligible).toBe(false);
  expect(authorizedBrowser.root).not.toBe(traceCli.root);
  transcript.packets[0].inputMask = 16;
  expect((await browserVerify(page, transcript)).ok).toBe(false);
  expect(errors).toEqual([]);
});

test("two real browser peers finish an idle round with identical complete histories", async ({ context }, testInfo) => {
  test.setTimeout(120_000);
  const host = await context.newPage();
  const joiner = await context.newPage();
  const errors = [];
  for (const page of [host, joiner]) page.on("pageerror", (error) => errors.push(error.message));
  await Promise.all([host.goto("/"), joiner.goto("/")]);
  await host.getByRole("button", { name: "Host Tab", exact: true }).click();
  await joiner.getByRole("button", { name: "Joiner Tab", exact: true }).click();
  for (const page of [host, joiner]) {
    await expect(page.getByTestId("peer-id")).not.toHaveText("initialize first");
  }
  await joiner.getByPlaceholder("Paste host peer ID in joiner tab").fill(await host.getByTestId("peer-id").innerText());
  await joiner.getByRole("button", { name: "Connect", exact: true }).click();
  for (const page of [host, joiner]) await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await host.getByRole("button", { name: "Start Match", exact: true }).click();
  for (const page of [host, joiner]) {
    await expect(page.getByText("300 / 300", { exact: true })).toBeVisible({ timeout: 45_000 });
    await developerMode(page);
  }
  const a = await exportTranscript(host);
  const b = await exportTranscript(joiner);
  expect(a.canonicalFrames).toHaveLength(300);
  expect(a.canonicalFrames).toEqual(b.canonicalFrames);
  expect(a.final).toEqual(b.final);
  expect(a.final.winner).toBe("TIE_BOTH_LOSE");
  for (const [name, page, transcript] of [["host", host, a], ["joiner", joiner, b]]) {
    const result = await browserVerify(page, transcript);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    const file = testInfo.outputPath(`${name}.json`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify(transcript));
    const cli = JSON.parse(execFileSync(process.execPath, ["tools/verify-match.mjs", file], { encoding: "utf8" }));
    expect(cli.replay).toEqual(result.replay);
  }
  const downloadPromise = host.waitForEvent("download");
  await host.getByRole("button", { name: "Export dispute evidence", exact: true }).click();
  const artifactText = await readFile(await (await downloadPromise).path(), "utf8");
  const artifact = JSON.parse(artifactText);
  expect(artifact.reconstruction.status).toBe("complete");
  expect(artifact.reconstruction.transcript).toEqual(a);
  const archiveFile = testInfo.outputPath("live-archive.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(archiveFile, JSON.stringify(artifact.archive));
  const rebuilt = execFileSync(process.execPath, ["tools/evidence-trace.mjs", "build", archiveFile], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  expect(rebuilt.trim()).toBe(artifactText);
  expect(errors).toEqual([]);
});
