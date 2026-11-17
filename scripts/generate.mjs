// Generate a model with Lux3D and add it to the app's ready-made Library.
//
//   npm run generate -- --image photos/car.jpg --name "Family car" --height 1.5
//   npm run generate -- --prompt "a red hatchback car" --name "Red hatchback" --height 1.5
//
// Optional provenance for a photo you did not take yourself:
//   --source-url <page> --credit "Author name" --license "CC0 1.0"
//
// Saves public/models/library/<slug>.glb, copies the source photo to
// public/models/sources/<slug>.<ext>, and adds an entry (with prompt or photo
// credit, task id, size and SHA-256) to public/models/library.json.

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createLux3D, downloadGlb, DEFAULT_FACE_COUNT } from '../lib/lux3d.mjs';
import { measureGlb } from '../public/glb-measure.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY_DIR = path.join(ROOT, 'public', 'models', 'library');
const SOURCES_DIR = path.join(ROOT, 'public', 'models', 'sources');
const LIBRARY_JSON = path.join(ROOT, 'public', 'models', 'library.json');

const { values: args } = parseArgs({
  options: {
    image: { type: 'string' },
    prompt: { type: 'string' },
    name: { type: 'string' },
    height: { type: 'string' },
    style: { type: 'string', default: 'photorealistic' },
    version: { type: 'string', default: 'G1-Turbo' },
    'face-count': { type: 'string' },
    'source-url': { type: 'string' },
    credit: { type: 'string' },
    license: { type: 'string' },
  },
});

function fail(message) {
  console.error(`\n${message}\n`);
  console.error('Usage:\n  npm run generate -- --image photos/car.jpg --name "Family car" --height 1.5');
  console.error('  npm run generate -- --prompt "a red hatchback car" --name "Red hatchback" --height 1.5');
  process.exit(1);
}

if (!args.image === !args.prompt) fail('Pass exactly one of --image or --prompt.');
if (!args.name) fail('Pass --name, e.g. --name "Family car".');
// Lux3D normalises text models to a ~10-unit box, so the real height must be given.
const realHeight = Number(args.height);
if (!(realHeight > 0)) fail('Pass --height with the real height in metres, e.g. --height 1.5 for a car.');
const faceCount = args['face-count'] === undefined ? DEFAULT_FACE_COUNT : Number(args['face-count']);
if (!(faceCount >= 0)) fail('--face-count must be a number (0 = Lux3D default).');

const slug = args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `model-${Date.now()}`;
const lux = createLux3D({ apiKey: process.env.LUX3D_API_KEY, baseUrl: process.env.LUX3D_BASE_URL || undefined });
const options = { version: args.version, style: args.style, faceCount };

let taskId;
let sourceImage;
if (args.image) {
  const bytes = await readFile(args.image);
  console.log(`Uploading ${args.image} (${(bytes.length / 1e6).toFixed(2)} MB)…`);
  const imageUrl = await lux.uploadImage(bytes, path.basename(args.image));
  taskId = await lux.createImageTo3D(imageUrl, options);
  const ext = path.extname(args.image).toLowerCase() || '.jpg';
  await mkdir(SOURCES_DIR, { recursive: true });
  await copyFile(args.image, path.join(SOURCES_DIR, `${slug}${ext}`));
  sourceImage = {
    url: `/models/sources/${slug}${ext}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(args['source-url'] && { sourceUrl: args['source-url'] }),
    ...(args.credit && { credit: args.credit }),
    ...(args.license && { license: args.license }),
  };
} else {
  taskId = await lux.createTextTo3D(args.prompt, options);
}
console.log(`Lux3D task ${taskId} created. This usually takes a few minutes…`);

const task = await lux.waitForTask(taskId, {
  onProgress: (t, ms) => process.stdout.write(`\r  ${t.state.padEnd(10)} ${Math.round(ms / 1000)}s `),
});
process.stdout.write('\n');
if (!task.glbUrl) fail(`Task ${taskId} finished without a GLB. Outputs: ${task.urls.join(', ')}`);

const bytes = await downloadGlb(task.glbUrl);
await mkdir(LIBRARY_DIR, { recursive: true });
await writeFile(path.join(LIBRARY_DIR, `${slug}.glb`), bytes);
const bounds = measureGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
const round = (v) => v.map((n) => Math.round(n * 1000) / 1000);

let library = [];
try {
  library = JSON.parse(await readFile(LIBRARY_JSON, 'utf8'));
} catch {
  library = [];
}
const entry = {
  id: slug,
  name: args.name,
  url: `/models/library/${slug}.glb`,
  realHeight,
  source: args.image ? 'lux3d-image-to-3d' : 'lux3d-text-to-3d',
  taskId,
  createdAt: new Date().toISOString(),
  generation: {
    version: options.version,
    ...(args.prompt ? { prompt: args.prompt, style: options.style } : { sourceImage }),
    faceCount,
    fileBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    gltfSize: round(bounds.size),
  },
};
library = [entry, ...library.filter((e) => e.id !== slug)];
await writeFile(LIBRARY_JSON, `${JSON.stringify(library, null, 2)}\n`);
console.log(`Saved ${entry.url} (${(bytes.length / 1e6).toFixed(1)} MB) and added it to the Library.`);
