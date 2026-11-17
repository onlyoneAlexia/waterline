// Optional, reproducible refresh of the bundled CC0 surface textures.
// Source/license: https://polyhaven.com/license. No API key or paid assets.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const output = new URL('../public/textures/', import.meta.url);
await fs.mkdir(output, { recursive: true });
const assets = { asphalt: 'asphalt_02', brick: 'brick_wall_001', paving: 'concrete_floor_02', grass: 'aerial_grass_rock' };
const manifest = [];
for (const [name, asset] of Object.entries(assets)) {
  const response = await fetch(`https://api.polyhaven.com/files/${asset}`, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Waterline/0.1 (hackathon texture preparation)' } });
  if (!response.ok) throw new Error(`Texture metadata ${asset}: HTTP ${response.status}`);
  const files = await response.json();
  for (const [channel, key] of [['diff', 'diff'], ['normal', 'nor_gl']]) {
    const channels = Object.entries(files).filter(([name]) => channel === 'diff' ? /diff|albedo|color/i.test(name) : /normal|nor_gl/i.test(name));
    const file = channels.flatMap(([, variants]) => Object.values(variants?.['1k'] ?? {})).find(file => file?.url && !file.url.includes('_nor_dx_') && /\.(jpg|png)$/.test(file.url));
    if (!file?.url) throw new Error(`No 1k ${key} for ${asset}`);
    const extension = new URL(file.url).pathname.split('.').at(-1);
    const downloaded = await fetch(file.url, { signal: AbortSignal.timeout(60000) });
    if (!downloaded.ok) throw new Error(`Texture ${asset}: HTTP ${downloaded.status}`);
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    const filename = `${name}-${channel}.${extension}`;
    await fs.writeFile(new URL(filename, output), bytes);
    manifest.push({ filename, asset, page: `https://polyhaven.com/a/${asset}`, url: file.url, license: 'CC0-1.0', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    console.log(`${filename}: ${bytes.length} bytes`);
  }
}
await fs.writeFile(new URL('sources.json', output), JSON.stringify(manifest, null, 2));
