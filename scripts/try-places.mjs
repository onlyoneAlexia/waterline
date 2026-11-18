// Search several places with the real "Your spot" box and screenshot each one.
// Run: node --env-file=.env scripts/try-places.mjs "Ikoyi, Lagos" "La Boca, Buenos Aires" ...
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createAppServer } from '../server.mjs';

const places = process.argv.slice(2);
if (!places.length) throw new Error('Name at least one place.');
const out = path.resolve('submission/evidence/places');
await fs.mkdir(out, { recursive: true });
const server = createAppServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=street&debug&nodemo`);
  await page.waitForFunction(() => window.waterline?.state.viewer && window.waterline.state.library.length > 0, null, { timeout: 60_000 });
  for (const [i, query] of places.entries()) {
    const started = Date.now();
    const result = { query };
    try {
      await page.evaluate(() => { document.querySelector('#pin-status').textContent = ''; });
      await page.locator('.rail [data-go="spot"]').click();
      await page.locator('#place-input').fill(query);
      await page.locator('#place-go').click();
      await page.waitForFunction(() => !document.querySelector('#place-results').hidden || /^(Flying|Finding|Search is|Nothing)/.test(document.querySelector('#place-status').textContent), null, { timeout: 30_000 });
      result.choices = await page.locator('#place-results .place-result').allTextContents();
      if (result.choices.length) await page.locator('#place-results .place-result').first().click();
      await page.waitForFunction(() => /^Your spot:|Couldn’t|Nothing|Search is/.test(document.querySelector('#pin-status').textContent + document.querySelector('#place-status').textContent), null, { timeout: 120_000 });
      result.seconds = Math.round((Date.now() - started) / 1000);
      result.spot = await page.evaluate(() => { const p = waterline.state.pin; return p && { lat: +(p.lat * 57.29578).toFixed(5), lon: +(p.lon * 57.29578).toFixed(5), height: +p.height.toFixed(1) }; });
      result.status = await page.locator('#pin-status').textContent();
      await page.waitForTimeout(15000);
      await page.screenshot({ path: path.join(out, `place-${i + 1}-dry.png`) });
      await page.evaluate(() => waterline.setDepth(0.6));
      await page.waitForTimeout(3000);
      await page.screenshot({ path: path.join(out, `place-${i + 1}.png`) });
      await page.locator('.rail [data-go="risk"]').click();
      await page.waitForSelector('#risk li, #risk .warning, #risk button', { timeout: 90_000 }).catch(() => {});
      result.risk = (await page.locator('#risk').textContent())?.replace(/Show/g, ' · ').trim().slice(0, 160);
      await page.evaluate(() => waterline.setDepth(0));
    } catch (error) { result.error = error.message.split('\n')[0]; }
    results.push(result);
    console.log(JSON.stringify(result));
  }
} finally {
  await fs.writeFile(path.join(out, 'places.json'), JSON.stringify(results, null, 2));
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
