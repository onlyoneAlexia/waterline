// Make an MP4 (H.264) copy of a WebM video, for upload forms that only accept MP4.
//
//   node scripts/webm-to-mp4.mjs submission/waterline-demo.webm submission/waterline-demo.mp4
//
// Playwright's bundled ffmpeg cannot encode H.264, but Microsoft Edge's MediaRecorder can:
// Edge plays the WebM in real time and records it as MP4. The result is then checked by
// loading it back in Edge (duration, size, and a decoded frame from the middle).

import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/webm-to-mp4.mjs <in.webm> <out.mp4>');
const files = { '/in.webm': [path.resolve(input), 'video/webm'], '/out.mp4': [path.resolve(output), 'video/mp4'] };

// Small static server with Range support, so the <video> element can stream and seek.
const server = http.createServer(async (req, res) => {
  const entry = files[new URL(req.url, 'http://x').pathname];
  if (!entry) { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><title>convert</title><body style="margin:0;background:#000">'); }
  const [file, type] = entry;
  const { size } = await fs.stat(file);
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  const start = range?.[1] ? Number(range[1]) : 0;
  const end = range?.[2] ? Number(range[2]) : size - 1;
  res.writeHead(range ? 206 : 200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(range && { 'content-range': `bytes ${start}-${end}/${size}` }) });
  createReadStream(file, { start, end }).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  await page.goto(`${origin}/`);
  const download = page.waitForEvent('download', { timeout: 15 * 60_000 });
  await page.evaluate(async () => {
    const video = Object.assign(document.createElement('video'), { src: '/in.webm', muted: true, playsInline: true, preload: 'auto' });
    document.body.append(video);
    await new Promise((resolve) => video.addEventListener('canplaythrough', resolve, { once: true }));
    const recorder = new MediaRecorder(video.captureStream(25), { mimeType: 'video/mp4;codecs=avc1.640028', videoBitsPerSecond: 7_000_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    recorder.onstop = () => {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' })), download: 'out.mp4' });
      document.body.append(a); a.click();
    };
    video.addEventListener('ended', () => setTimeout(() => recorder.stop(), 300), { once: true });
    recorder.start(1000);
    await video.play();
  });
  await (await download).saveAs(path.resolve(output));

  // Check the MP4 by playing it back.
  const check = await page.evaluate(async () => {
    const video = Object.assign(document.createElement('video'), { src: `/out.mp4?${Date.now()}`, muted: true, preload: 'auto' });
    document.body.append(video);
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('MP4 does not load')); });
    let duration = video.duration;
    if (!Number.isFinite(duration)) { // fragmented MP4: seek far to make the browser measure it
      video.currentTime = 1e6; await new Promise((r) => (video.onseeked = r)); duration = video.duration; video.currentTime = 0;
    }
    video.currentTime = duration / 2; await new Promise((r) => (video.onseeked = r));
    const canvas = new OffscreenCanvas(64, 36); const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 64, 36);
    const pixels = ctx.getImageData(0, 0, 64, 36).data; let sum = 0; for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
    return { duration, width: video.videoWidth, height: video.videoHeight, midFrameBrightness: Math.round(sum / (pixels.length / 4) / 3) };
  });
  const { size } = await fs.stat(output);
  console.log(`Wrote ${output} · ${(size / 1e6).toFixed(1)} MB · ${JSON.stringify(check)}`);
  if (!(check.duration > 10) || !check.width || check.midFrameBrightness < 10) throw new Error('The MP4 did not verify.');
} finally {
  await browser.close();
  server.close();
}
