const { chromium } = require('/home/node/.openclaw/workspace/node_modules/playwright-chromium');
const { writeFileSync } = require('node:fs');

const url = 'http://127.0.0.1:4173/';
const out = '/home/node/.openclaw/workspace/crypto-fighter/crypto-fighter-self-play.png';
const transcriptOut = '/home/node/.openclaw/workspace/crypto-fighter/crypto-fighter-self-play-transcript.json';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const host = await context.newPage();
  const joiner = await context.newPage();

  await Promise.all([
    host.goto(url, { waitUntil: 'networkidle', timeout: 60000 }),
    joiner.goto(url, { waitUntil: 'networkidle', timeout: 60000 }),
  ]);

  await host.getByRole('button', { name: 'Host Tab' }).click();
  await joiner.getByRole('button', { name: 'Joiner Tab' }).click();

  await host.getByText('peer open:', { exact: false }).waitFor({ timeout: 30000 });
  await joiner.getByText('peer open:', { exact: false }).waitFor({ timeout: 30000 });

  const hostPeerId = await host.locator('section').filter({ hasText: 'Peer connection' }).locator('div').filter({ hasText: /^[a-zA-Z0-9_-]+$/ }).first().innerText();
  await joiner.getByPlaceholder('Paste host peer ID in joiner tab').fill(hostPeerId.trim());
  await joiner.getByRole('button', { name: 'Connect' }).click();

  await Promise.all([
    host.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 }),
    joiner.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 }),
  ]);

  await host.getByRole('button', { name: 'Start Match' }).click();
  await host.waitForTimeout(250);

  // Move fighters toward each other.
  await host.keyboard.down('d');
  await joiner.keyboard.down('ArrowLeft');
  await host.waitForTimeout(2300);
  await host.keyboard.up('d');
  await joiner.keyboard.up('ArrowLeft');

  // Trade attacks.
  for (let i = 0; i < 4; i++) {
    await host.keyboard.press('f');
    await joiner.keyboard.press('/');
    await host.waitForTimeout(400);
  }

  await host.waitForTimeout(500);
  const transcriptJson = await host.locator('section').filter({ hasText: 'Transcript export' }).locator('pre').innerText();
  writeFileSync(transcriptOut, transcriptJson);
  await host.screenshot({ path: out, fullPage: true });

  console.log('screenshot', out);
  console.log('transcript', transcriptOut);
  console.log('host body', (await host.locator('body').innerText()).slice(0, 900));
  console.log('joiner body', (await joiner.locator('body').innerText()).slice(0, 900));
  await browser.close();
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
