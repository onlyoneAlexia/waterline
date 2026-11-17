// Shrink Library GLBs for the web: re-encode their PNG textures as JPEG (geometry untouched).
//
//   node scripts/optimise-library.mjs            # every Library model not yet optimised
//
// Lux3D returns 2048 px PNG textures, which make up most of each 9-17 MB file. Opaque
// materials don't need PNG's alpha or lossless encoding, so JPEG cuts each file by ~60-75%.
// The original Lux3D download is kept in .waterline/original-models/ (not served or shipped),
// and library.json records the original and shipped sizes and SHA-256 hashes.
// Encoding uses the installed Microsoft Edge (via Playwright) as the image codec.

import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { measureGlb } from '../public/glb-measure.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const LIBRARY_JSON = path.join(PUBLIC_DIR, 'models', 'library.json');
const ORIGINALS = path.join(ROOT, '.waterline', 'original-models');
const BASE_COLOR = { maxSize: 2048, quality: 0.88 };
const OTHER = { maxSize: 1024, quality: 0.9 }; // metallic-roughness and other data maps
const MARKER = 'waterline-texture-optimisation';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pad4 = (n) => (n + 3) & ~3;

export function parseGlb(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2) throw new Error('not a glTF 2.0 GLB');
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first chunk is not JSON');
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
  const binHeader = 20 + jsonLength;
  const bin = binHeader < bytes.length ? bytes.subarray(binHeader + 8, binHeader + 8 + bytes.readUInt32LE(binHeader)) : Buffer.alloc(0);
  return { json, bin };
}

export function buildGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(pad4(jsonBytes.length) - jsonBytes.length, 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc(pad4(bin.length) - bin.length)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunk = (type, body) => { const h = Buffer.alloc(8); h.writeUInt32LE(body.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, body]); };
  return Buffer.concat([header, chunk(0x4e4f534a, jsonChunk), chunk(0x004e4942, binChunk)]);
}

/** Replace some bufferViews' bytes and repack the binary chunk with 4-byte alignment. */
export function repack(json, bin, replacements) {
  const parts = [];
  let offset = 0;
  json.bufferViews.forEach((view, index) => {
    if ((view.buffer ?? 0) !== 0) throw new Error('only single-buffer GLBs are supported');
    const bytes = replacements.get(index) ?? bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const aligned = pad4(offset);
    if (aligned > offset) parts.push(Buffer.alloc(aligned - offset));
    view.byteOffset = aligned;
    view.byteLength = bytes.length;
    parts.push(bytes);
    offset = aligned + bytes.length;
  });
  json.buffers[0].byteLength = offset;
  return Buffer.concat(parts);
}

async function encoder() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const encode = (bytes, mimeType, { maxSize, quality }) => page.evaluate(async ({ b64, mimeType, maxSize, quality }) => {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([raw], { type: mimeType }));
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const out = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
    return { b64: btoa(s), width: canvas.width, height: canvas.height };
  }, { b64: bytes.toString('base64'), mimeType, ...{ maxSize, quality } });
  return { encode, close: () => browser.close() };
}

async function optimise(file, codec) {
  const original = await readFile(file);
  const { json, bin } = parseGlb(original);
  if (json.asset?.extras?.[MARKER]) return null;
  const alphaTextures = new Set(json.materials?.filter((m) => m.alphaMode && m.alphaMode !== 'OPAQUE')
    .map((m) => m.pbrMetallicRoughness?.baseColorTexture?.index).filter((i) => i != null));
  const baseColorImages = new Set(json.materials?.map((m) => m.pbrMetallicRoughness?.baseColorTexture?.index)
    .filter((i) => i != null).map((i) => json.textures[i].source));
  const replacements = new Map();
  for (const [index, image] of (json.images ?? []).entries()) {
    if (image.bufferView == null || image.mimeType !== 'image/png') continue;
    if (json.textures.some((t, ti) => t.source === index && alphaTextures.has(ti))) continue; // keep alpha
    const view = json.bufferViews[image.bufferView];
    const bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const result = await codec.encode(bytes, image.mimeType, baseColorImages.has(index) ? BASE_COLOR : OTHER);
    replacements.set(image.bufferView, Buffer.from(result.b64, 'base64'));
    image.mimeType = 'image/jpeg';
  }
  if (!replacements.size) return null;
  const packed = repack(json, bin, replacements);
  json.asset.extras = { ...json.asset.extras, [MARKER]: `PNG textures re-encoded as JPEG (base colour ≤${BASE_COLOR.maxSize}px q${BASE_COLOR.quality}, others ≤${OTHER.maxSize}px q${OTHER.quality}); geometry unchanged` };
  const output = buildGlb(json, packed);
  // The rendered size must not change.
  const before = measureGlb(original.buffer.slice(original.byteOffset, original.byteOffset + original.length));
  const after = measureGlb(output.buffer.slice(output.byteOffset, output.byteOffset + output.length));
  if (before.size.some((v, i) => Math.abs(v - after.size[i]) > 1e-6)) throw new Error(`${file}: bounds changed`);
  return { original, output };
}

async function main() {
const library = JSON.parse(await readFile(LIBRARY_JSON, 'utf8'));
const codec = await encoder();
try {
  await mkdir(ORIGINALS, { recursive: true });
  for (const entry of library) {
    if (!entry.url?.startsWith('/models/library/')) continue;
    const file = path.join(PUBLIC_DIR, entry.url);
    const result = await optimise(file, codec);
    if (!result) { console.log(`${entry.id}: already optimised`); continue; }
    const backup = path.join(ORIGINALS, path.basename(file));
    try { await access(backup); } catch { await copyFile(file, backup); }
    await writeFile(file, result.output);
    entry.generation = {
      ...entry.generation,
      fileBytes: entry.generation?.fileBytes ?? result.original.length,
      sha256: entry.generation?.sha256 ?? sha256(result.original),
      shipped: { fileBytes: result.output.length, sha256: sha256(result.output), textures: 'JPEG (re-encoded from Lux3D PNG); geometry unchanged' },
    };
    console.log(`${entry.id}: ${(result.original.length / 1e6).toFixed(1)} MB → ${(result.output.length / 1e6).toFixed(1)} MB`);
  }
} finally {
  await codec.close();
}
await writeFile(LIBRARY_JSON, `${JSON.stringify(library, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
