// Screenshots of the homepage (with the scroll shatter) and the app overlays, for a visual check.
// Run with the app server running: node scripts/shots-home.mjs [--app] [base URL]
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:3000';
const out = path.resolve('submission/evidence/home');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const errors = [];
try {
  for (const [name, viewport] of [['desktop', { width: 1600, height: 950 }], ['laptop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.goto(base + '/');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);
    const h = await page.evaluate(() => document.querySelector('.h-card').offsetHeight);
    for (const [k, top] of [['0', 0], ['30', h * 0.2], ['60', h * 0.42], ['split', h + 40]]) {
      await page.evaluate((y) => document.querySelector('#home').scrollTo(0, y), top);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(out, `${name}-${k}.png`) });
    }
    await page.evaluate(() => { const home = document.querySelector('#home'); home.scrollTo(0, document.querySelector('.h-tour').offsetTop - 20); });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, `${name}-tour.png`) });
    const overflow = await page.evaluate(() => document.querySelector('#home').scrollWidth > document.querySelector('#home').clientWidth + 1);
    console.log(name, 'card height', h, 'horizontal overflow', overflow);
    await page.close();
  }
  if (process.argv.includes('--app')) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    page.on('pageerror', (e) => errors.push(`app: ${e.message}`));
    await page.goto(base + '/?mode=street&debug');
    await page.waitForFunction(() => window.waterline?.state.pin, null, { timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(20_000);
    await page.screenshot({ path: path.join(out, 'app-street.png') });
    await page.locator('.rail [data-go="water"]').click().catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, 'app-simulate.png') });
    await page.locator('.rail [data-go="things"]').click().catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, 'app-things.png') });
  }
} finally {
  console.log('errors', JSON.stringify(errors));
  await browser.close();
}
