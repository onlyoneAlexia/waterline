// Builds one room from a photo through the real UI (one paid Aholo World generation, ~10 minutes),
// then opens it with the water up. Run: node --env-file=.env scripts/verify-room-build.mjs [photo.jpg]
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createAppServer } from '../server.mjs';

const photo = path.resolve(process.argv[2] ?? 'public/models/worlds/example-living-room.jpg');
const server = createAppServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=studio&debug`);
  await page.waitForFunction(() => window.waterline?.state.objects.length >= 1, null, { timeout: 60_000 });
  await page.locator('.rail [data-go="inside"]').click();
  await page.locator('#room-photo').setInputFiles(photo);
  await page.locator('#room-go').click();
  const t0 = Date.now();
  let last = '';
  while (!(await page.evaluate(() => !!window.waterline.state.room))) {
    const status = await page.locator('#room-jobs').textContent();
    if (status !== last) { console.log(Math.round((Date.now() - t0) / 1000) + 's', status); last = status; }
    if (/Room: (?!ready|Aholo World is building|sending|connection)/.test(status)) throw new Error(status);
    if (Date.now() - t0 > 40 * 60_000) throw new Error('Timed out');
    await page.waitForTimeout(10_000);
  }
  await page.evaluate(() => waterline.setDepth(0.8));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'submission/evidence/14-room-from-photo.png' });
  console.log('room ready in', Math.round((Date.now() - t0) / 1000), 's', JSON.stringify(await page.evaluate(() => waterline.state.room.info())));
} catch (error) {
  console.log('FAILED', error.message);
  process.exitCode = 1;
} finally {
  console.log('errors:', JSON.stringify(errors));
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
