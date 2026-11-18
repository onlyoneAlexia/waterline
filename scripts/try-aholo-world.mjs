// One Aholo World generation, to check the account can use it and see what comes back.
// Makes ONE paid world generation. Run: node --env-file=.env scripts/try-aholo-world.mjs ["prompt"] [--image path.jpg]
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLux3D } from '../lib/lux3d.mjs';

const args = process.argv.slice(2);
const imageAt = args.indexOf('--image');
const imagePath = imageAt >= 0 ? args[imageAt + 1] : null;
const prompt = args.find((a, i) => !a.startsWith('--') && i !== imageAt + 1)
  ?? 'A cosy ground-floor living room seen from the doorway: wooden floor, a grey sofa, a low coffee table, a TV on a cabinet, a bookshelf, a window and a front door. Daylight.';
const client = createLux3D({ apiKey: process.env.LUX3D_API_KEY });
const dir = path.resolve('.waterline/worlds');
await fs.mkdir(dir, { recursive: true });
const host = (url) => { try { return new URL(url).host + new URL(url).pathname.replace(/^.*\./, ' .'); } catch { return null; } };

const started = Date.now();
const imageUrl = imagePath ? await client.uploadImage(await fs.readFile(imagePath), 'photo.jpg') : undefined;
const worldId = await client.createWorld({ prompt, imageUrl, name: 'Waterline room test' });
console.log('world', worldId, 'created', imagePath ? 'from a photo' : 'from text');
let world;
for (;;) {
  world = await client.getWorld(worldId);
  console.log(`${Math.round((Date.now() - started) / 1000)}s`, world.status, world.progress ?? '');
  if (['succeeded', 'failed', 'cancelled'].includes(world.state)) break;
  if (Date.now() - started > 40 * 60_000) throw new Error('Gave up after 40 minutes');
  await new Promise((r) => setTimeout(r, 10_000));
}
await fs.writeFile(path.join(dir, `${worldId}.json`), JSON.stringify({ worldId, prompt, image: imagePath, seconds: Math.round((Date.now() - started) / 1000), world }, null, 2));
if (world.state !== 'succeeded') throw new Error(`World ${world.state}: ${world.message}`);
console.log('assets:', { spz: host(world.spzUrl), ply: host(world.plyUrl), pano: host(world.panoUrl), upAxis: world.upAxis });
for (const [kind, url] of [['spz', world.spzUrl], ['jpg', world.panoUrl]]) {
  if (!url) continue;
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(path.join(dir, `${worldId}.${kind}`), bytes);
  console.log(kind, response.status, (bytes.length / 1e6).toFixed(2), 'MB');
}
console.log('done in', Math.round((Date.now() - started) / 1000), 's');
