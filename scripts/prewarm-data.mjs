// Fetch weather, past-event and OpenStreetMap data for the demo places and save
// them as committed fixtures (data/fixtures/<place>-<kind>.json). The server
// falls back to these when the live APIs fail and nothing is cached.
//
//   npm run prewarm
//   node scripts/prewarm-data.mjs --only paiporta
//   node scripts/prewarm-data.mjs --osm-from paiporta=overpass-raw.json   (use a saved Overpass answer)
//
// Live results also land in .waterline/cache/, so the demo machine starts warm.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createWeatherService } from '../lib/weather.mjs';
import { createOsmService, parseOverpass, ATTRIBUTION as OSM_ATTRIBUTION } from '../lib/osm.mjs';
import { DEFAULT_FIXTURES_DIR } from '../lib/disk-cache.mjs';

export const PLACES = {
  kerrville: { lat: 30.043724, lon: -99.142402, event: { start: '2025-07-02', end: '2025-07-06' } },
  paiporta: { lat: 39.427992, lon: -0.418102, event: { start: '2024-10-27', end: '2024-10-31' } },
  // "Simulate my area" examples used in the demo video and report (no recorded event).
  houston: { lat: 29.6866, lon: -95.4592 },
  lagos: { lat: 6.428, lon: 3.422 },
};
const OSM_RADIUS = 900;
const MAX_FIXTURE_BYTES = 1_400_000;

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = option('--only')?.split(',');
const osmFrom = Object.fromEntries((option('--osm-from') ?? '').split(',').filter(Boolean).map((pair) => pair.split('=')));

// Never answer from fixtures while making fixtures.
const noFixtures = path.join(DEFAULT_FIXTURES_DIR, '__none__');
const weather = createWeatherService({ fixturesDir: noFixtures });
const osm = createOsmService({ fixturesDir: noFixtures, endpointTimeoutMs: 90_000, totalBudgetMs: 240_000 });

async function save(place, kind, meta, body) {
  const { status, sources, ...rest } = body; // status is set to 'fixture' when served
  let data = rest;
  let text = JSON.stringify({ fixture: { kind, place, ...meta, createdAt: new Date().toISOString() }, body: data });
  while (kind === 'osm' && text.length > MAX_FIXTURE_BYTES) {
    data = { ...data, buildings: data.buildings.slice(0, Math.floor(data.buildings.length * 0.8)), roads: data.roads.slice(0, Math.floor(data.roads.length * 0.8)) };
    text = JSON.stringify({ fixture: { kind, place, ...meta, trimmed: true, createdAt: new Date().toISOString() }, body: data });
  }
  await mkdir(DEFAULT_FIXTURES_DIR, { recursive: true });
  const file = path.join(DEFAULT_FIXTURES_DIR, `${place}-${kind}.json`);
  await writeFile(file, `${text}\n`);
  return { file: path.relative(process.cwd(), file), bytes: Buffer.byteLength(text) + 1, from: status ?? 'raw' };
}

async function osmFromFile(place, { lat, lon }, file) {
  const json = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(json?.elements) || json.remark) throw new Error(`${file} is not a complete Overpass answer`);
  const stamp = Date.parse(json.osm3s?.timestamp_osm_base ?? '');
  return {
    ...parseOverpass(json, { lat, lon }),
    radius: OSM_RADIUS,
    fetchedAt: new Date(Number.isFinite(stamp) ? stamp : Date.now()).toISOString(),
    status: 'raw',
    attribution: OSM_ATTRIBUTION,
  };
}

const jobs = [];
for (const [place, spot] of Object.entries(PLACES)) {
  if (only && !only.includes(place)) continue;
  const { lat, lon, event } = spot;
  jobs.push(...[
    ['weather',() => weather.forecast(lat, lon), { lat, lon }],
    ...(event ? [['event', () => weather.event(lat, lon, event.start, event.end), { lat, lon, ...event }]] : []),
    ['osm', () => (osmFrom[place] ? osmFromFile(place, spot, osmFrom[place]) : osm.around(lat, lon, OSM_RADIUS)), { lat, lon, radius: OSM_RADIUS }],
  ].map(([kind, run, meta]) => ({ place, kind, run, meta })));
}

let failed = 0;
// Weather jobs run together; Overpass jobs one at a time (the public servers are shared).
const results = await Promise.all(jobs.map(async (job) => {
  if (job.kind === 'osm') return null;
  try {
    const body = await job.run();
    return { job, saved: await save(job.place, job.kind, job.meta, body) };
  } catch (error) {
    return { job, error };
  }
}));
for (const job of jobs.filter((j) => j.kind === 'osm')) {
  try {
    const body = await job.run();
    results.push({ job, saved: await save(job.place, job.kind, job.meta, body) });
  } catch (error) {
    results.push({ job, error });
  }
}

for (const result of results.filter(Boolean)) {
  const label = `${result.job.place}-${result.job.kind}`.padEnd(18);
  if (result.error) {
    failed += 1;
    console.error(`✗ ${label} ${result.error.message} (existing fixture, if any, kept)`);
  } else {
    console.log(`✓ ${label} ${result.saved.file}  ${(result.saved.bytes / 1024).toFixed(0)} KB  (${result.saved.from})`);
  }
}
process.exitCode = failed ? 1 : 0;
