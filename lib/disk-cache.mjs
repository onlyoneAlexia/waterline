// Small JSON cache on disk (.waterline/cache/) plus committed fixtures
// (data/fixtures/) so the weather and OpenStreetMap endpoints keep answering
// when the free public APIs behind them are slow or down.
//
// Every value is stored as { savedAt, data }. A corrupt or half-written file
// is treated as a miss. Writes go to a temp file first and are then renamed.

import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CACHE_DIR = path.join(ROOT, '.waterline', 'cache');
export const DEFAULT_FIXTURES_DIR = path.join(ROOT, 'data', 'fixtures');

export const USER_AGENT = 'Waterline/0.2 (flood-awareness demo)';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Turn arbitrary key parts into a safe file name (no ':' or slashes; Windows-safe). */
export function cacheKey(...parts) {
  return parts
    .map((part) => String(part).replace(/[^A-Za-z0-9._-]+/g, '_'))
    .join('_')
    .slice(0, 150);
}

/** Round a coordinate for cache keys (3 dp is about 110 m). */
export const round3 = (value) => Number(value).toFixed(3);

export function metresBetween(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.hypot(x, y) * 6_371_000;
}

export function createDiskCache({ dir = DEFAULT_CACHE_DIR, now = Date.now } = {}) {
  let counter = 0;
  const fileFor = (key) => path.join(dir, `${cacheKey(key)}.json`);

  async function read(key) {
    try {
      const entry = JSON.parse(await readFile(fileFor(key), 'utf8'));
      if (!entry || typeof entry !== 'object' || !Number.isFinite(entry.savedAt) || !('data' in entry)) return null;
      return entry;
    } catch {
      return null; // Missing or corrupt: a miss.
    }
  }

  async function write(key, data) {
    const file = fileFor(key);
    const temp = `${file}.${process.pid}.${++counter}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(temp, JSON.stringify({ savedAt: now(), data }));
      await rename(temp, file);
    } catch (error) {
      console.warn(`[cache] could not save ${path.basename(file)}: ${error.message}`);
      await unlink(temp).catch(() => {});
    }
  }

  return { dir, read, write, now };
}

/**
 * Share one promise between concurrent identical requests.
 * @param {Map<string, Promise>} map
 */
export function dedupe(map, key, load) {
  if (!map.has(key)) map.set(key, Promise.resolve().then(load).finally(() => map.delete(key)));
  return map.get(key);
}

/**
 * Cached loader for one upstream source.
 *  - fresh cache  -> { status: 'cached' }
 *  - live fetch   -> { status: 'live' } (and saved)
 *  - fetch failed -> stale cache { status: 'stale' } or { status: 'failed' }
 * `load()` must throw on upstream failure. It may return null for a valid
 * "no data here" answer (for example sea level far inland); null is cached too.
 */
export async function loadSource({ cache, key, ttlMs, load, inflight }) {
  const entry = await cache.read(key);
  if (entry && cache.now() - entry.savedAt < ttlMs) {
    return { status: 'cached', data: entry.data, fetchedAt: entry.savedAt };
  }
  const run = async () => {
    const data = await load();
    await cache.write(key, data);
    return { status: 'live', data, fetchedAt: cache.now() };
  };
  try {
    return await (inflight ? dedupe(inflight, key, run) : run());
  } catch (error) {
    if (entry) return { status: 'stale', data: entry.data, fetchedAt: entry.savedAt, error };
    return { status: 'failed', data: null, fetchedAt: null, error };
  }
}

/**
 * Committed fixtures: data/fixtures/*.json, each
 *   { fixture: { kind, place, lat, lon, start?, end?, radius?, createdAt }, body: { ...response } }
 */
export function createFixtureStore({ dir = DEFAULT_FIXTURES_DIR, maxMetres = 1500 } = {}) {
  let listing = null;

  async function load() {
    listing ??= (async () => {
      const out = [];
      let names = [];
      try {
        names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
      } catch {
        return out; // No fixtures directory.
      }
      for (const name of names) {
        try {
          const parsed = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
          const meta = parsed?.fixture;
          if (meta && typeof meta.kind === 'string' && Number.isFinite(meta.lat) && Number.isFinite(meta.lon) && parsed.body && typeof parsed.body === 'object') {
            out.push({ meta, file: path.join(dir, name) });
          }
        } catch (error) {
          console.warn(`[fixtures] skipping ${name}: ${error.message}`);
        }
      }
      return out;
    })();
    return listing;
  }

  /** Nearest fixture of `kind` within maxMetres whose metadata passes `accept`. Returns the body or null. */
  async function find(kind, lat, lon, accept = () => true) {
    let best = null;
    for (const item of await load()) {
      if (item.meta.kind !== kind || !accept(item.meta)) continue;
      const metres = metresBetween({ lat, lon }, item.meta);
      if (metres <= maxMetres && (!best || metres < best.metres)) best = { ...item, metres };
    }
    if (!best) return null;
    try {
      return JSON.parse(await readFile(best.file, 'utf8')).body;
    } catch {
      return null;
    }
  }

  return { find, reset: () => { listing = null; } };
}

/** Fetch JSON with a timeout. Never throws on bad JSON: returns { ok, status, json|null }. Throws on network/timeout. */
export async function fetchJson(fetchImpl, url, { timeoutMs = 20_000, method = 'GET', body, headers = {} } = {}) {
  const response = await fetchImpl(url, {
    method,
    body,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try {
    json = JSON.parse(await response.text());
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error;
    json = null;
  }
  return { ok: response.ok, status: response.status, json };
}

export function upstreamError(message, status = 502) {
  return Object.assign(new Error(message), { status });
}
