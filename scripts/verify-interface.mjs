// Check the real interface without requiring Cesium's CDN or live map services.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createAppServer } from '../server.mjs';

const server = createAppServer({});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
  await page.route('**/app.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: app.slice(0, app.lastIndexOf('init().catch('))
      + '\nwireUi(); await loadLibrary(); renderFacts(); setDepth(0); window.interfaceReady = true;',
  }));
  await page.route('**/interface-preview', (route) => route.fulfill({
    contentType: 'text/html',
    body: html.replace(/<script src="https:[^"]+"><\/script>/g, '')
      .replace(/<link rel="stylesheet" href="https:[^"]+">/g, ''),
  }));
  await page.goto(`http://127.0.0.1:${server.address().port}/interface-preview`);
  await page.waitForFunction(() => window.interfaceReady);
  assert.equal(await page.locator('#home').isVisible(), true, 'The homepage shows first.');
  await page.locator('[data-home]').evaluate(() => document.documentElement.classList.remove('home-open'));
  await page.locator('.rail [data-go="things"]').click();
  await assert.doesNotReject(() => page.getByRole('tabpanel', { name: 'Library' }).waitFor());
  await page.getByRole('tab', { name: 'Library', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Photo', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#panel-photo').isVisible(), true);
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: '60 cm', exact: true }).click();
  assert.equal(await page.locator('#depth-out').textContent(), '0.60 m');
  assert.equal(await page.locator('#map-depth-value').textContent(), '0.60 m');
  assert.equal(await page.getByRole('button', { name: '60 cm', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#safe-go').isDisabled(), true);
  for (const name of ['spot', 'water', 'risk', 'safety', 'detective', 'share', 'things']) {
    await page.locator(`.rail [data-go="${name}"]`).click();
    assert.equal(await page.locator('.space:not([hidden])').count(), 1, name);
    assert.equal(await page.locator(`.space[data-space="${name}"]`).isVisible(), true, name);
  }
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      panelOverflow: document.querySelector('#panel').scrollWidth > document.querySelector('#panel').clientWidth,
      mapHeight: document.querySelector('#map').getBoundingClientRect().height,
    }));
    assert.equal(layout.overflow, false, JSON.stringify(viewport));
    assert.equal(layout.panelOverflow, false, JSON.stringify(viewport));
    assert.ok(layout.mapHeight > 200);
    await page.locator('#panel').evaluate((panel) => { panel.style.scrollBehavior = 'auto'; panel.scrollTop = 0; });
    await page.screenshot({ path: `test/interface-${viewport.width}.png` });
    console.log(`Interface verified at ${viewport.width} × ${viewport.height}`);
  }
  assert.deepEqual(errors, []);
  console.log('Keyboard tabs, depth controls, initial action states, and responsive layout passed. Live map excluded.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
