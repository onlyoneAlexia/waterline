// Find when each on-screen caption appears in the stitched demo video, by watching the caption band.
// Writes submission/recordings/caption-segments.json and a contact sheet to label them.
//   node scripts/caption-times.mjs submission/waterline-demo.webm
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const input = path.resolve(process.argv[2] ?? 'submission/waterline-demo.webm');
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/in.webm')) { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><body style="margin:0">'); }
  const { size } = await fs.stat(input);
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  const start = range?.[1] ? Number(range[1]) : 0;
  const end = range?.[2] ? Number(range[2]) : size - 1;
  res.writeHead(range ? 206 : 200, { 'content-type': input.endsWith('.mp4') ? 'video/mp4' : 'video/webm', 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(range && { 'content-range': `bytes ${start}-${end}/${size}` }) });
  createReadStream(input, { start, end }).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const video = Object.assign(document.createElement('video'), { src: '/in.webm', muted: true, preload: 'auto' });
    document.body.append(video);
    await new Promise((r) => video.addEventListener('loadeddata', r, { once: true }));
    let duration = video.duration;
    if (!Number.isFinite(duration)) { video.currentTime = 1e6; await new Promise((r) => (video.onseeked = r)); duration = video.duration; }
    const W = video.videoWidth, H = video.videoHeight;
    const band = { x: W * 0.12, y: H * 0.01, w: W * 0.76, h: H * 0.16 };
    const small = new OffscreenCanvas(192, 24), sctx = small.getContext('2d', { willReadFrequently: true });
    const seek = (t) => new Promise((r) => { video.onseeked = r; video.currentTime = t; });
    const sig = () => {
      sctx.drawImage(video, band.x, band.y, band.w, band.h, 0, 0, 192, 24);
      const d = sctx.getImageData(0, 0, 192, 24).data, g = new Float32Array(192 * 24);
      let dark = 0;
      for (let i = 0; i < g.length; i++) { g[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3; if (d[i * 4 + 2] < 60 && d[i * 4] < 40) dark++; }
      return { g, dark: dark / g.length };
    };
    const samples = [];
    for (let t = 0.2; t < duration; t += 0.5) { await seek(t); samples.push({ t, ...sig() }); }
    // A caption is on screen when the band has the dark pill (#08111f) in it.
    const on = samples.map((s) => s.dark > 0.08);
    const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
    const segments = [];
    let cur = null;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (!on[i]) { if (cur) { cur.end = s.t; segments.push(cur); cur = null; } continue; }
      if (cur && diff(cur.ref, s.g) > 14) { cur.end = s.t; segments.push(cur); cur = null; }
      if (!cur) cur = { start: s.t, ref: s.g };
    }
    if (cur) { cur.end = duration; segments.push(cur); }
    const kept = segments.filter((s) => s.end - s.start >= 1).map(({ start, end }) => ({ start: +start.toFixed(1), end: +end.toFixed(1) }));
    // Contact sheet: the caption band a second into each segment.
    const sheet = new OffscreenCanvas(960, 80 * kept.length), ctx = sheet.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sheet.width, sheet.height);
    for (const [i, s] of kept.entries()) {
      await seek(Math.min(s.end - 0.1, s.start + 1.2));
      ctx.drawImage(video, band.x, band.y, band.w, band.h, 90, i * 80, 870, 78);
      ctx.fillStyle = '#000'; ctx.font = 'bold 16px sans-serif'; ctx.fillText(`${i}: ${s.start}s`, 4, i * 80 + 44);
    }
    const blob = await sheet.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
    return { duration, segments: kept, sheet: btoa(bin) };
  });
  await fs.writeFile('submission/recordings/caption-segments.json', JSON.stringify({ duration: result.duration, segments: result.segments }, null, 2));
  await fs.writeFile('submission/recordings/caption-sheet.png', Buffer.from(result.sheet, 'base64'));
  console.log(result.duration, JSON.stringify(result.segments));
} finally {
  await browser.close();
  server.close();
}
