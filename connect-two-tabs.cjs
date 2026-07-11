const { chromium } = require('/home/node/.openclaw/workspace/node_modules/playwright-chromium');

const url = 'http://127.0.0.1:4173/';
const out = '/home/node/.openclaw/workspace/crypto-fighter/crypto-fighter-connected.png';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const host = await context.newPage();
  const joiner = await context.newPage();

  for (const [name, page] of [['host', host], ['joiner', joiner]]) {
    page.on('console', (msg) => console.log(`${name} console ${msg.type()}: ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`${name} pageerror: ${err.stack || err.message}`));
  }

  await Promise.all([
    host.goto(url, { waitUntil: 'networkidle', timeout: 60000 }),
    joiner.goto(url, { waitUntil: 'networkidle', timeout: 60000 }),
  ]);

  await host.getByRole('button', { name: 'Host Tab' }).click();
  await joiner.getByRole('button', { name: 'Joiner Tab' }).click();

  await host.getByText('peer open:', { exact: false }).waitFor({ timeout: 30000 });
  await joiner.getByText('peer open:', { exact: false }).waitFor({ timeout: 30000 });

  const hostPeerId = await host.locator('section').filter({ hasText: 'Peer connection' }).locator('div').filter({ hasText: /^[a-zA-Z0-9_-]+$/ }).first().innerText();
  console.log('hostPeerId', hostPeerId);

  await joiner.getByPlaceholder('Paste host peer ID in joiner tab').fill(hostPeerId.trim());
  await joiner.getByRole('button', { name: 'Connect' }).click();

  await Promise.all([
    host.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 }),
    joiner.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 }),
  ]);

  await host.getByRole('button', { name: 'Start Match' }).click();
  await host.waitForTimeout(1000);
  await host.screenshot({ path: out, fullPage: true });
  console.log('screenshot', out);
  console.log('host body', (await host.locator('body').innerText()).slice(0, 600));
  console.log('joiner body', (await joiner.locator('body').innerText()).slice(0, 600));
  await browser.close();
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
