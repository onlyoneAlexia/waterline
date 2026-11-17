// Render a transparent 3/4-view thumbnail of every Library model for the Library cards.
//
//   npm run thumbs
//
// Uses the installed Microsoft Edge and <model-viewer> (loaded from jsDelivr at build time only;
// the app itself serves the finished PNGs locally). Writes public/models/thumbs/<id>.png and
// sets `thumbnail` on each entry in public/models/library.json.

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const LIBRARY_JSON = path.join(PUBLIC_DIR, 'models', 'library.json');
const THUMBS = path.join(PUBLIC_DIR, 'models', 'thumbs');
const SIZE = { width: 360, height: 270 };

const page = (url) => `<!doctype html><meta charset=utf-8>
<script type=module src="https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js"></script>
<style>html,body{margin:0;background:transparent}model-viewer{width:${SIZE.width}px;height:${SIZE.height}px;--poster-color:transparent}model-viewer::part(default-progress-bar){display:none}</style>
<model-viewer src="${url}" camera-orbit="32deg 74deg auto" field-of-view="26deg" exposure="1.05"
  shadow-intensity="1.1" shadow-softness="0.9" environment-image="neutral" interaction-prompt="none"></model-viewer>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/thumb') { res.setHeader('content-type', 'text/html'); return res.end(page(url.searchParams.get('m'))); }
  const file = path.join(PUBLIC_DIR, path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !file.endsWith('.glb')) { res.statusCode = 404; return res.end(); }
  try { res.setHeader('content-type', 'model/gltf-binary'); res.end(await readFile(file)); } catch { res.statusCode = 404; res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
try {
  const library = JSON.parse(await readFile(LIBRARY_JSON, 'utf8'));
  await mkdir(THUMBS, { recursive: true });
  const tab = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  for (const entry of library) {
    if (!entry.url?.startsWith('/models/library/')) continue;
    await tab.goto(`http://127.0.0.1:${server.address().port}/thumb?m=${encodeURIComponent(entry.url)}`);
    await tab.waitForFunction(() => document.querySelector('model-viewer')?.loaded, null, { timeout: 120000 });
    await tab.waitForTimeout(800);
    const out = path.join(THUMBS, `${entry.id}.png`);
    await tab.locator('model-viewer').screenshot({ path: out, omitBackground: true });
    entry.thumbnail = `/models/thumbs/${entry.id}.png`;
    console.log(`${entry.id} → ${path.relative(ROOT, out)}`);
  }
  await writeFile(LIBRARY_JSON, `${JSON.stringify(library, null, 2)}\n`);
} finally {
  await browser.close();
  server.close();
}
