import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

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
  await page.getByPlaceholder("Paste transcript JSON here...").fill(JSON.stringify(transcript));
  await page.getByRole("button", { name: "Verify + Load", exact: true }).click();
  await expect(page.getByText(/Verifier: ok/)).toBeVisible();
  const browser = await browserVerify(page, transcript);
  expect(browser.ok).toBe(true);
  expect(browser.replay).toEqual(cli.replay);
  expect(browser.replay.winner).toBe("P1");
  expect(browser.replay.roundOver).toBe(true);
  transcript.packets[0].inputMask = 16;
  expect((await browserVerify(page, transcript)).ok).toBe(false);
  expect(errors).toEqual([]);
});

test("two real browser peers finish an idle round with identical complete histories", async ({ context }, testInfo) => {
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
  expect(errors).toEqual([]);
});
