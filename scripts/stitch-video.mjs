// Join kept time ranges of a recording into one WebM (VP9).
//
//   node scripts/stitch-video.mjs <raw.webm> <keep.json> <out.webm>
//
// keep.json is [[startSeconds, endSeconds, optionalOtherFile], ...]. Playwright's bundled ffmpeg can only decode
// VP9/MJPEG and only encode VP9/PNG, with no concat or pipe-out support. So each range is decoded
// to PNG frames, Microsoft Edge re-encodes them as JPEG, and they stream into one VP9 encoder.

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const FFMPEG = path.resolve('.playwright', 'ffmpeg-1013', 'ffmpeg-win64.exe');
const FPS = 25;

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
});

export async function stitch(raw, keep, output) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'waterline-stitch-'));
  const server = http.createServer(async (req, res) => {
    try { res.setHeader('access-control-allow-origin', '*'); res.setHeader('content-type', 'image/png'); res.end(await fs.readFile(path.join(tmp, path.basename(req.url)))); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.setContent('<title>stitch</title>');
  const encoder = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-c:v', 'libvpx-vp9', '-b:v', '5M', '-deadline', 'realtime', '-cpu-used', '5', '-row-mt', '1', '-pix_fmt', 'yuv420p', output], { stdio: ['pipe', 'inherit', 'inherit'] });
  const encoded = new Promise((resolve, reject) => encoder.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`encoder exited with ${code}`)))));
  const write = (bytes) => new Promise((resolve) => (encoder.stdin.write(bytes) ? resolve() : encoder.stdin.once('drain', resolve)));
  let frames = 0;
  try {
    for (const [index, [start, end, source]] of keep.entries()) {
      const prefix = `r${String(index).padStart(2, '0')}_`;
      await run(['-loglevel', 'error', '-ss', start.toFixed(2), '-i', source ?? raw, '-t', (end - start).toFixed(2), '-r', String(FPS), path.join(tmp, `${prefix}%05d.png`)]);
      const names = (await fs.readdir(tmp)).filter((name) => name.startsWith(prefix)).sort();
      for (const name of names) {
        const jpeg = await page.evaluate(async (url) => {
          const bitmap = await createImageBitmap(await (await fetch(url)).blob());
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.93 })).arrayBuffer());
          let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(text);
        }, `http://127.0.0.1:${server.address().port}/${name}`);
        await write(Buffer.from(jpeg, 'base64'));
        await fs.unlink(path.join(tmp, name));
        frames++;
      }
      console.log(`range ${index + 1}/${keep.length}: ${start.toFixed(1)}–${end.toFixed(1)} s (${names.length} frames)`);
    }
    encoder.stdin.end();
    await encoded;
  } catch (error) {
    encoder.kill(); // report the first failure, not the encoder's complaint about missing input
    encoded.catch(() => {});
    throw error;
  } finally {
    await browser.close();
    server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return frames / FPS;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [raw, keepFile, output] = process.argv.slice(2);
  const seconds = await stitch(raw, JSON.parse(await fs.readFile(keepFile, 'utf8')), output);
  console.log(`Wrote ${output} · ${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`);
}
