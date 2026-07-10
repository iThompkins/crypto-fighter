const { chromium } = require('/home/node/.openclaw/workspace/node_modules/playwright-chromium');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on('console', (msg) => console.log('console', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.log('pageerror', err.stack || err.message));
  const resp = await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('status', resp && resp.status());
  await page.waitForTimeout(2000);
  console.log('title', await page.title());
  console.log('body', (await page.locator('body').innerText()).slice(0, 500));
  await browser.close();
})();
