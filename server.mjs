// Waterline server: serves the web app and keeps the Lux3D API key private.
//
//   GET  /api/config        -> { cesiumToken, generationEnabled }
//   POST /api/generate      -> { taskId }   body: { image: dataURL } or { prompt }
//   GET  /api/task?id=...   -> { state, url?, error? }
//   POST /api/world         -> { worldId }  body: { image: dataURL, prompt? } or { prompt }   (Aholo World room)
//   GET  /api/world?id=...  -> { state, progress?, url?, upAxis?, error? }
//   GET  /api/flood-depth?lat=..&lon=..  -> modelled river-flood depths (JRC / Copernicus)
//   GET  /api/route?from=lon,lat&to=lon,lat -> walking route (FOSSGIS OSRM, OpenStreetMap)
//
// Finished models are saved under public/models/generated/ so they keep working
// after Lux3D's download links expire.

import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLux3D, downloadGlb, Lux3DError } from './lib/lux3d.mjs';
import { createFloodDepthService } from './lib/flood-depth.mjs';

const ROUTING_URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';
const MAX_ROUTE_METRES = 15_000;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CESIUM_DIR = path.join(ROOT, 'node_modules', 'cesium', 'Build', 'Cesium');
const GENERATED_DIR = path.join(PUBLIC_DIR, 'models', 'generated');
const TASKS_DIR = path.join(ROOT, '.waterline', 'tasks');
const WORLDS_DIR = path.join(PUBLIC_DIR, 'models', 'worlds');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.spz': 'application/octet-stream',
};

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_PROMPT_CHARS = 300;

const exists = (file) => stat(file).then((s) => s.isFile(), () => false);

function parseLonLat(text) {
  const parts = String(text ?? '').split(',').map(Number);
  if (parts.length !== 2 || !parts.every(Number.isFinite)) return null;
  const [lon, lat] = parts;
  return Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? { lon, lat } : null;
}

function metresBetween(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.hypot(x, y) * 6_371_000;
}

// Tiny bounded cache so repeated lookups (share links, re-clicks) stay cheap.
function memo(limit = 500) {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set(key, value) {
      map.set(key, value);
      if (map.size > limit) map.delete(map.keys().next().value);
    },
  };
}

export function createAppServer(env = process.env, { floodDepth = createFloodDepthService(), fetchImpl = fetch, luxClient, downloadModel = downloadGlb, generatedDir = GENERATED_DIR, tasksDir = TASKS_DIR, worldsDir = WORLDS_DIR } = {}) {
  const maxPerDay = Number(env.MAX_GENERATIONS_PER_DAY ?? 40);
  const maxPerIpPerHour = Number(env.MAX_GENERATIONS_PER_IP_PER_HOUR ?? 6);
  const trustProxy = env.TRUST_PROXY === '1';

  let lux = luxClient ?? null;
  try {
    lux ??= createLux3D({ apiKey: env.LUX3D_API_KEY, baseUrl: env.LUX3D_BASE_URL || undefined });
  } catch (error) {
    console.warn(`[lux3d] ${error.message}; photo/text generation is disabled`);
  }

  const tasks = new Map(); // taskId -> { name, createdAt }
  const inflight = new Map(); // taskId -> Promise of a status check
  const hitsByIp = new Map();
  let quotaDay = new Date().toISOString().slice(0, 10);
  let quotaUsed = 0;

  function clientIp(req) {
    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    return forwarded || req.socket.remoteAddress || 'unknown';
  }

  function takeQuota(ip) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== quotaDay) {
      quotaDay = today;
      quotaUsed = 0;
    }
    if (quotaUsed >= maxPerDay) {
      return 'The demo has used up today’s new models. Try the ready-made models in the Library tab.';
    }
    const now = Date.now();
    const recent = (hitsByIp.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= maxPerIpPerHour) {
      return 'You have made a lot of models this hour. Please try again a little later.';
    }
    recent.push(now);
    hitsByIp.set(ip, recent);
    quotaUsed += 1;
    return null;
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request is too large'), { status: 413 });
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw Object.assign(new Error('Request body must be JSON'), { status: 400 });
    }
  }

  async function handleGenerate(req, res) {
    if (!lux) return sendJson(res, 503, { error: 'Model generation is not configured on this server.' });
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'Request body must be a JSON object.' });
    const name = String(body.name ?? '').trim().slice(0, 60) || 'My object';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const image = typeof body.image === 'string' ? body.image : '';
    if (!prompt === !image) return sendJson(res, 400, { error: 'Send either a photo or a description.' });
    if (prompt.length > MAX_PROMPT_CHARS) return sendJson(res, 400, { error: `Keep the description under ${MAX_PROMPT_CHARS} characters.` });

    let photo = null;
    if (image) {
      const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image);
      if (!match) return sendJson(res, 400, { error: 'The photo must be a JPEG, PNG or WebP image.' });
      photo = { bytes: Buffer.from(match[2], 'base64'), ext: match[1] === 'jpeg' ? 'jpg' : match[1] };
    }

    const blocked = takeQuota(clientIp(req));
    if (blocked) return sendJson(res, 429, { error: blocked });

    const taskId = photo
      ? await lux.createImageTo3D(await lux.uploadImage(photo.bytes, `photo.${photo.ext}`))
      : await lux.createTextTo3D(prompt);
    const record = { name, createdAt: Date.now(), source: photo ? 'lux3d-image-to-3d' : 'lux3d-text-to-3d' };
    tasks.set(taskId, record);
    await mkdir(tasksDir, { recursive: true });
    await writeFile(path.join(tasksDir, `${taskId}.json`), JSON.stringify(record));
    console.log(`[lux3d] task ${taskId} created (${photo ? 'photo' : 'text'}: ${name})`);
    return sendJson(res, 200, { taskId });
  }

  async function checkTask(taskId) {
    const task = await lux.getTask(taskId);
    if (task.state === 'succeeded') {
      if (!task.glbUrl) return { state: 'failed', error: 'Lux3D finished but returned no GLB model.' };
      const bytes = await downloadModel(task.glbUrl);
      await mkdir(generatedDir, { recursive: true });
      await writeFile(path.join(generatedDir, `${taskId}.glb`), bytes);
      console.log(`[lux3d] task ${taskId} saved (${(bytes.length / 1e6).toFixed(1)} MB)`);
      return { state: 'done', url: `/models/generated/${taskId}.glb` };
    }
    if (task.state === 'failed' || task.state === 'cancelled') {
      return { state: 'failed', error: task.message || `Lux3D task ${task.state}.` };
    }
    return { state: task.state };
  }

  async function handleTask(url, res) {
    const taskId = url.searchParams.get('id') ?? '';
    if (!/^\d{1,30}$/.test(taskId)) return sendJson(res, 400, { error: 'Invalid task id' });
    if (await exists(path.join(generatedDir, `${taskId}.glb`))) {
      return sendJson(res, 200, { state: 'done', url: `/models/generated/${taskId}.glb` });
    }
    if (!tasks.has(taskId)) {
      try {
        const record = JSON.parse(await readFile(path.join(tasksDir, `${taskId}.json`), 'utf8'));
        if (record?.createdAt > Date.now() - 7 * 86_400_000) tasks.set(taskId, record);
      } catch { /* Unknown or expired task. */ }
    }
    if (!lux || !tasks.has(taskId)) return sendJson(res, 404, { error: 'Unknown task' });
    if (!inflight.has(taskId)) {
      inflight.set(taskId, checkTask(taskId).finally(() => inflight.delete(taskId)));
    }
    return sendJson(res, 200, await inflight.get(taskId));
  }

  // ---------- Aholo World: your room as Gaussian splats ----------

  const worlds = new Map(); // worldId -> { name, createdAt }
  const worldChecks = new Map();

  function parsePhoto(image) {
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!match) throw Object.assign(new Error('The photo must be a JPEG, PNG or WebP image.'), { status: 400 });
    return { bytes: Buffer.from(match[2], 'base64'), ext: match[1] === 'jpeg' ? 'jpg' : match[1] };
  }

  async function handleWorldCreate(req, res) {
    if (!lux) return sendJson(res, 503, { error: 'Aholo World is not configured on this server.' });
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'Request body must be a JSON object.' });
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const image = typeof body.image === 'string' ? body.image : '';
    if (!prompt && !image) return sendJson(res, 400, { error: 'Send a photo of your room, a description, or both.' });
    if (prompt.length > MAX_PROMPT_CHARS) return sendJson(res, 400, { error: `Keep the description under ${MAX_PROMPT_CHARS} characters.` });
    const photo = image ? parsePhoto(image) : null;
    const blocked = takeQuota(clientIp(req));
    if (blocked) return sendJson(res, 429, { error: blocked });
    const imageUrl = photo ? await lux.uploadImage(photo.bytes, `photo.${photo.ext}`) : undefined;
    const worldId = await lux.createWorld({ prompt, imageUrl, name: 'Waterline room' });
    const record = { name: 'room', createdAt: Date.now() };
    worlds.set(worldId, record);
    await mkdir(tasksDir, { recursive: true });
    await writeFile(path.join(tasksDir, `world-${worldId}.json`), JSON.stringify(record));
    console.log(`[world] ${worldId} created (${photo ? 'photo' : 'text'})`);
    return sendJson(res, 200, { worldId });
  }

  async function checkWorld(worldId) {
    const world = await lux.getWorld(worldId);
    if (world.state === 'succeeded') {
      if (!world.spzUrl) return { state: 'failed', error: 'Aholo World finished but returned no splat file.' };
      // Aholo World's file host can be slow to answer from far away, so give the download a few tries.
      let bytes;
      for (let attempt = 1; !bytes; attempt++) {
        try {
          const response = await fetchImpl(world.spzUrl, { signal: AbortSignal.timeout(300_000) });
          if (!response.ok) throw new Lux3DError(`Room download failed with HTTP ${response.status}`);
          bytes = Buffer.from(await response.arrayBuffer());
        } catch (error) {
          if (attempt >= 3) throw error instanceof Lux3DError ? error : new Lux3DError('Room download failed. Try again in a minute.');
        }
      }
      await mkdir(worldsDir, { recursive: true });
      await writeFile(path.join(worldsDir, `${worldId}.spz`), bytes);
      await writeFile(path.join(worldsDir, `${worldId}.json`), JSON.stringify({ upAxis: world.upAxis }));
      console.log(`[world] ${worldId} saved (${(bytes.length / 1e6).toFixed(1)} MB)`);
      return { state: 'done', url: `/models/worlds/${worldId}.spz`, upAxis: world.upAxis };
    }
    if (world.state === 'failed' || world.state === 'cancelled') return { state: 'failed', error: world.message || `Aholo World ${world.status?.toLowerCase?.() ?? 'failed'}.` };
    return { state: world.state, progress: world.progress };
  }

  async function handleWorld(url, res) {
    const worldId = url.searchParams.get('id') ?? '';
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(worldId)) return sendJson(res, 400, { error: 'Invalid world id' });
    if (await exists(path.join(worldsDir, `${worldId}.spz`))) {
      let upAxis = 'Z';
      try { upAxis = JSON.parse(await readFile(path.join(worldsDir, `${worldId}.json`), 'utf8')).upAxis === 'Y' ? 'Y' : 'Z'; } catch { /* default */ }
      return sendJson(res, 200, { state: 'done', url: `/models/worlds/${worldId}.spz`, upAxis });
    }
    if (!worlds.has(worldId)) {
      try {
        const record = JSON.parse(await readFile(path.join(tasksDir, `world-${worldId}.json`), 'utf8'));
        if (record?.createdAt > Date.now() - 7 * 86_400_000) worlds.set(worldId, record);
      } catch { /* Unknown or expired world. */ }
    }
    if (!lux || !worlds.has(worldId)) return sendJson(res, 404, { error: 'Unknown room' });
    if (!worldChecks.has(worldId)) worldChecks.set(worldId, checkWorld(worldId).finally(() => worldChecks.delete(worldId)));
    return sendJson(res, 200, await worldChecks.get(worldId));
  }

  const depthCache = memo();
  async function handleFloodDepth(url, res) {
    if (!['lat', 'lon'].every((key) => url.searchParams.get(key)?.trim())) {
      return sendJson(res, 400, { error: 'lat and lon are required' });
    }
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return sendJson(res, 400, { error: 'lat and lon are required' });
    }
    const key = `${lon.toFixed(4)},${lat.toFixed(4)}`;
    let result = depthCache.get(key);
    if (!result) {
      result = await floodDepth.depthsAt(lon, lat);
      depthCache.set(key, result);
    }
    return sendJson(res, 200, result);
  }

  const routeCache = memo();
  async function handleRoute(url, res) {
    const from = parseLonLat(url.searchParams.get('from'));
    const to = parseLonLat(url.searchParams.get('to'));
    if (!from || !to) return sendJson(res, 400, { error: 'from and to must be "lon,lat"' });
    if (metresBetween(from, to) > MAX_ROUTE_METRES) return sendJson(res, 400, { error: 'Those points are too far apart to walk.' });
    const key = [from.lon, from.lat, to.lon, to.lat].map((v) => v.toFixed(5)).join(',');
    let route = routeCache.get(key);
    if (!route) {
      const target = `${ROUTING_URL}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
      const response = await fetchImpl(target, {
        headers: { 'User-Agent': 'Waterline/0.1 (flood-awareness demo)' },
        signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json().catch(() => null);
      const best = data?.routes?.[0];
      if (!response.ok || data?.code !== 'Ok' || !best?.geometry?.coordinates?.length) {
        return sendJson(res, 502, { error: 'No walking route found.' });
      }
      route = { distance: best.distance, duration: best.duration, coordinates: best.geometry.coordinates };
      routeCache.set(key, route);
    }
    return sendJson(res, 200, route);
  }

  async function serveStatic(url, res) {
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: 'Bad path' });
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const vendor = pathname.startsWith('/vendor/cesium/');
    const directory = vendor ? CESIUM_DIR : PUBLIC_DIR;
    const relative = vendor ? pathname.slice('/vendor/cesium/'.length) : pathname;
    const file = path.normalize(path.join(directory, relative));
    if (!file.startsWith(directory + path.sep) || !(await exists(file))) {
      res.writeHead(404, { 'Content-Type': MIME['.txt'] });
      return res.end('Not found');
    }
    const ext = path.extname(file).toLowerCase();
    const cache = ext === '.glb' || ext === '.spz' ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': cache });
    res.end(await readFile(file));
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { status: 'ok', studioReady: await exists(path.join(CESIUM_DIR, 'Cesium.js')) && await exists(path.join(PUBLIC_DIR, 'models', 'library', 'family-suv.glb')) });
      }
      if (url.pathname === '/api/config' && req.method === 'GET') {
        return sendJson(res, 200, { cesiumToken: env.CESIUM_ION_TOKEN || null, generationEnabled: Boolean(lux) });
      }
      if (url.pathname === '/api/generate' && req.method === 'POST') return await handleGenerate(req, res);
      if (url.pathname === '/api/task' && req.method === 'GET') return await handleTask(url, res);
      if (url.pathname === '/api/world' && req.method === 'POST') return await handleWorldCreate(req, res);
      if (url.pathname === '/api/world' && req.method === 'GET') return await handleWorld(url, res);
      if (url.pathname === '/api/flood-depth' && req.method === 'GET') return await handleFloodDepth(url, res);
      if (url.pathname === '/api/route' && req.method === 'GET') return await handleRoute(url, res);
      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
      return await serveStatic(url, res);
    } catch (error) {
      const status = error.status ?? (error instanceof Lux3DError ? 502 : 500);
      if (status >= 500) console.error(`[server] ${req.method} ${url.pathname}:`, error.message, error.cause?.code ?? error.cause?.message ?? '');
      if (!res.headersSent) sendJson(res, status, { error: error.message || 'Something went wrong' });
      else res.end();
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 3000);
  createAppServer().listen(port, () => {
    console.log(`Waterline running at http://localhost:${port}`);
    if (!process.env.CESIUM_ION_TOKEN) console.warn('[cesium] No ion token; Studio demo works, real-street mode needs a token.');
  });
}
