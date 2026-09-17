const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('pageerror', err.stack || err.message));
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.screenshot({ path: 'crypto-fighter-screenshot.png', fullPage: true });
  console.log((await page.locator('body').innerText()).slice(0, 200));
  await browser.close();
})();
