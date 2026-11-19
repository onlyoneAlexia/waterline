// Add the female voice-over (scripts/voiceover-tts.ps1 clips) to the demo video.
// Edge plays the silent WebM in real time while Web Audio plays each clip at its caption's time,
// and MediaRecorder records picture + voice as MP4 (H.264/AAC) and WebM (VP9/Opus).
//   node scripts/add-voiceover.mjs submission/waterline-demo.webm
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const input = path.resolve(process.argv[2] ?? 'submission/waterline-demo.webm');
const lines = JSON.parse((await fs.readFile('scripts/voiceover-lines.json', 'utf8')).replace(/^﻿/, ''));
const clipDir = path.resolve('submission/recordings/voiceover');
const files = { '/in.webm': [input, 'video/webm'] };
lines.forEach((_, i) => { files[`/line-${i}.wav`] = [path.join(clipDir, `line-${String(i).padStart(2, '0')}.wav`), 'audio/wav']; });

const server = http.createServer(async (req, res) => {
  const entry = files[new URL(req.url, 'http://x').pathname];
  if (!entry) { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><title>voice</title><body style="margin:0;background:#000">'); }
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
const tmp = { mp4: path.resolve('submission/recordings/voiced.mp4'), webm: path.resolve('submission/recordings/voiced.webm') };
try {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('console', (m) => console.log('page:', m.text()));
  await page.goto(`${origin}/`);
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  await page.evaluate(async (cues) => {
    // Load the whole video into memory first, so playback never waits for the disk or the network.
    const blobUrl = URL.createObjectURL(await (await fetch('/in.webm')).blob());
    const video = Object.assign(document.createElement('video'), { src: blobUrl, muted: true, playsInline: true, preload: 'auto' });
    let stalls = 0; video.addEventListener('waiting', () => stalls++);
    document.body.append(video);
    await new Promise((resolve) => video.addEventListener('canplaythrough', resolve, { once: true }));
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    const clips = await Promise.all(cues.map(async (_, i) => ctx.decodeAudioData(await (await fetch(`/line-${i}.wav`)).arrayBuffer())));
    const voice = ctx.createGain();
    voice.gain.value = 1.4;
    const dest = ctx.createMediaStreamDestination();
    voice.connect(dest);
    // A constant, inaudible tone keeps the recorded audio track continuous, so it cannot slip against the picture.
    const hum = ctx.createOscillator(); const hush = ctx.createGain(); hush.gain.value = 0.0005; hum.frequency.value = 40; hum.connect(hush).connect(dest); hum.start();
    const stream = new MediaStream([...video.captureStream(25).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const kinds = [
      ['out.mp4', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4'],
    ].filter(([, mime]) => MediaRecorder.isTypeSupported(mime));
    console.log('recording', kinds.map((k) => k[1]).join(' + '));
    const recorders = kinds.map(([name, mimeType, type]) => {
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 7_000_000, audioBitsPerSecond: 128_000 });
      const chunks = [];
      recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
      recorder.onstop = () => {
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(chunks, { type })), download: name });
        document.body.append(a); a.click();
      };
      return recorder;
    });
    // Start each clip when the picture reaches its caption (the picture can stall; the audio clock does not).
    const started = new Set();
    const tick = () => {
      cues.forEach((cue, i) => {
        if (started.has(i) || video.currentTime < cue.at) return;
        started.add(i);
        const source = ctx.createBufferSource();
        source.buffer = clips[i];
        source.connect(voice);
        source.start();
      });
    };
    const timer = setInterval(tick, 20);
    video.addEventListener('timeupdate', tick);
    video.addEventListener('ended', () => { clearInterval(timer); console.log('stalls', stalls); }, { once: true });
    video.addEventListener('ended', () => setTimeout(() => recorders.forEach((r) => r.stop()), 400), { once: true });
    recorders.forEach((r) => r.start(1000));
    await video.play();
  }, lines);
  await page.waitForFunction(() => document.querySelectorAll('a[download]').length >= 1, null, { timeout: 10 * 60_000, polling: 1000 });
  await page.waitForTimeout(3000);
  for (const d of downloads) await d.saveAs(d.suggestedFilename() === 'out.mp4' ? tmp.mp4 : tmp.webm);

  // Check: the MP4 has picture and an audible voice track.
  files['/check.mp4'] = [tmp.mp4, 'video/mp4'];
  const check = await page.evaluate(async () => {
    const buffer = await (await fetch('/check.mp4')).arrayBuffer();
    const audio = await new AudioContext().decodeAudioData(buffer.slice(0));
    const data = audio.getChannelData(0);
    let sum = 0; for (let i = 0; i < data.length; i += 10) sum += data[i] * data[i];
    const video = Object.assign(document.createElement('video'), { src: '/check.mp4', muted: true, preload: 'auto' });
    document.body.append(video);
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('MP4 does not load')); });
    let duration = video.duration;
    if (!Number.isFinite(duration)) { video.currentTime = 1e6; await new Promise((r) => (video.onseeked = r)); duration = video.duration; }
    return { duration, width: video.videoWidth, height: video.videoHeight, audioSeconds: audio.duration, audioRms: Math.sqrt(sum / (data.length / 10)) };
  });
  console.log(JSON.stringify(check));
  if (!(check.duration > 60 && check.duration < 215) || !check.width || !(check.audioRms > 0.005)) throw new Error('The voiced MP4 did not verify (length or sound).');
  await fs.copyFile(tmp.mp4, path.resolve('submission/waterline-demo.mp4'));
  if (downloads.some((d) => d.suggestedFilename() === 'out.webm')) await fs.copyFile(tmp.webm, path.resolve('submission/waterline-demo.webm'));
  for (const f of ['submission/waterline-demo.mp4']) console.log(f, ((await fs.stat(f)).size / 1e6).toFixed(1), 'MB');
} finally {
  await browser.close();
  server.close();
}
