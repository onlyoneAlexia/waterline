// Builds the submission package in submission/: the project report (PDF, 16:9 deck), Lux3D asset
// evidence, a checklist, an X post draft and the source archive. It does not register, publish,
// post or submit anything. Run scripts/capture-sim.mjs first for fresh screenshots and numbers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { measureGlb } from '../public/glb-measure.js';

const root = path.resolve('.'), out = path.join(root, 'submission');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (file, fallback) => JSON.parse(await fs.readFile(file, 'utf8').catch(() => JSON.stringify(fallback)));

// ---------- Lux3D evidence: every shipped Library model and extra, verified against its file ----------
const library = await readJson('public/models/library.json', []);
const evidence = [];
for (const entry of library) {
  const bytes = await fs.readFile(path.join('public', entry.url));
  const bounds = measureGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const shipped = sha256(bytes);
  if (entry.generation?.shipped?.sha256 && entry.generation.shipped.sha256 !== shipped) throw new Error(`${entry.id}: file does not match library.json`);
  evidence.push({ ...entry, shippedFile: { bytes: bytes.length, sha256: shipped, gltfSize: bounds.size.map((v) => +v.toFixed(3)) } });
}
const extras = await readJson('public/models/extras/extras.json', []);
for (const item of extras) {
  const bytes = await fs.readFile(path.join('public', item.file));
  if (item.sha256 && item.sha256 !== sha256(bytes)) throw new Error(`${item.id}: file does not match extras.json`);
}
await fs.writeFile(path.join(out, 'lux3d-evidence.json'), JSON.stringify({ library: evidence, extras }, null, 2));
const lux = evidence.filter((e) => e.source?.startsWith('lux3d'));
const fromPhoto = lux.filter((e) => e.source === 'lux3d-image-to-3d');
const fromText = lux.filter((e) => e.source === 'lux3d-text-to-3d');
const endpointsUsed = new Set(['generate/img-to-3d', 'generate/text-to-3d']);
for (const item of extras) for (const e of [item.endpoint].flat()) endpointsUsed.add(String(e).replace(/^\/global\/lux3d\/v1\//, '').replace(/\/task\/create$/, ''));
const extrasTasks = extras.reduce((n, item) => n + (item.taskIds?.length ?? 0), 0);
const stats = await readJson('submission/report/sim-stats.json', {});
const testFiles = (await fs.readdir('test')).filter((name) => name.endsWith('.test.mjs'));
const testCount = (await Promise.all(testFiles.map((f) => fs.readFile(path.join('test', f), 'utf8')))).reduce((n, src) => n + (src.match(/^test\(/gm) ?? []).length, 0);

// ---------- the report (16:9 deck) ----------
const esc = (t) => String(t ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const img = (src, alt, cls = '') => `<img class="${cls}" src="${src}" alt="${esc(alt)}">`;
const num = (n) => (Number.isFinite(n) ? n.toLocaleString('en-GB') : '–');
let pageNo = 0;
const slide = (kicker, title, body, cls = '') => `<section class="${cls}"><div class="top"><span class="logotype">WATERLINE</span><span class="pill">${++pageNo} · ${kicker}</span></div>${title ? `<h1>${title}</h1>` : ''}${body}</section>`;
// A close crop of a full-app screenshot (the map, not the panels), for small cards.
const zoom = (src, alt, at) => `<div class="zoom"><img src="${src}" alt="${esc(alt)}" style="${at}"></div>`;
const card = (step, title, text, picture) => `<div class="card">${picture ?? ''}<span class="step">${step}</span><h3>${title}</h3><p>${text}</p></div>`;
const P = stats.paiporta ?? {};
const K = stats.kerrville ?? {};
const L = stats.lagos ?? {};
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
const statLine = (s) => (s.buildings ? `${num(s.areaKm2)} km² flooded · ${num(s.buildings.wet)} of ${plural(s.buildings.total, 'building', 'buildings')} in water · ${plural(s.buildings.deep, 'ground floor', 'ground floors')} flooded · ${num(s.roadsCutKm)} km of road cut · ${num(s.services?.hit)} of ${plural(s.services?.total, 'service', 'services')} in water` : `${num(s.areaKm2)} km² flooded`);
const extraRow = (kind) => extras.filter((e) => e.kind === kind);
const taskList = (items) => items.flatMap((i) => i.taskIds ?? []).join(', ');

const ENDPOINTS = [
  ['Image-to-3D', 'generate/img-to-3d', 'Your photo → a true-scale model, live in the app; the scooter and small car; the walking person', fromPhoto.map((e) => e.taskId).concat(taskList(extraRow('rig-walk')).split(', ').slice(1, 2)).filter(Boolean).join(', ')],
  ['Text-to-3D', 'generate/text-to-3d', '“a red pickup truck” → model, live; the SUV, door, bin and person', fromText.map((e) => e.taskId).join(', ')],
  ['Multimodal-to-image', 'generate/multimodal-to-image', 'Mud-stained SUV reference; A-pose reference so the person could be rigged', taskList(extraRow('reference-image'))],
  ['Material transfer', 'generate/material-transfer', 'The SUV “after the flood”, swapped in as the water drops', taskList(extraRow('material-transfer')).split(', ').slice(1).join(', ')],
  ['Rig + retarget', 'animations/rig · animations/retarget', 'The person who walks the escape route (walk cycle, in place)', taskList(extraRow('rig-walk')).split(', ').slice(2).join(', ')],
  ['Part-split', 'part-split', 'SUV → body + four wheels (which parts are under water)', taskList(extraRow('part-split'))],
  ['Articulation', 'articulation-animation', 'The front door’s hinge, so it can swing open', taskList(extraRow('articulation'))],
  ['Multi-format export', 'multi-format-export', 'USDZ for AR on a phone, STL for 3D printing; live via /api/export', [...new Set(extras.filter((e) => e.kind.startsWith('export')).flatMap((e) => e.taskIds ?? []))].join(', ')],
];

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Waterline: project report</title><style>
@font-face { font-family: 'Cinzel Decorative'; font-weight: 700; src: url('../public/fonts/cinzel-decorative-700.woff2'); }
@font-face { font-family: 'Poppins'; font-weight: 400; src: url('../public/fonts/poppins-400.woff2'); }
@font-face { font-family: 'Poppins'; font-weight: 500; src: url('../public/fonts/poppins-500.woff2'); }
@font-face { font-family: 'Poppins'; font-weight: 600; src: url('../public/fonts/poppins-600.woff2'); }
@font-face { font-family: 'Poppins'; font-weight: 700; src: url('../public/fonts/poppins-700.woff2'); }
@page { size: 1280px 720px; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font: 14.5px/1.5 Poppins, sans-serif; color: #3d2318; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
section { position: relative; width: 1280px; height: 720px; padding: 30px 50px 28px; overflow: hidden; break-after: page;
  background: radial-gradient(55% 45% at 100% 0%, rgba(255,255,255,.6), transparent 70%), linear-gradient(180deg, #c3e8fa, #e8f6fd); }
section:last-child { break-after: auto; }
section.alt { background: radial-gradient(50% 45% at 0% 0%, rgba(255,255,255,.6), transparent 70%), linear-gradient(180deg, #fdf2df, #fbe3bd); }
.top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.logotype { font-weight: 700; font-size: 15px; letter-spacing: .34em; }
.pill { padding: 4px 12px; border-radius: 999px; background: rgba(255,255,255,.8); border: 1px solid rgba(61,35,24,.1); color: #6b4a3a; font-size: 11.5px; font-weight: 500; }
h1 { margin: 0 0 12px; font: 700 31px/1.14 'Cinzel Decorative', Georgia, serif; letter-spacing: -.01em; }
h2 { margin: 0 0 5px; font: 600 11.5px Poppins; letter-spacing: .16em; text-transform: uppercase; color: #b8650d; }
h3 { margin: 4px 0 3px; font: 600 15px/1.3 Poppins; }
p { margin: 0 0 8px; } ul { margin: 0; padding-left: 17px; } li { margin: 0 0 5px; }
b { color: #3d2318; }
.lede { font-size: 17px; line-height: 1.5; color: #6b4a3a; }
.kick { font: 600 12px Poppins; letter-spacing: .22em; text-transform: uppercase; color: #b8650d; margin: 0 0 6px; }
.muted { color: #957563; }
.small { font-size: 12px; }
.grid { display: grid; gap: 18px; }
.g2 { grid-template-columns: 1fr 1fr; } .g37 { grid-template-columns: 37fr 63fr; } .g45 { grid-template-columns: 42fr 58fr; } .g3 { grid-template-columns: repeat(3, 1fr); } .g4 { grid-template-columns: repeat(4, 1fr); }
.shot { display: block; width: 100%; border-radius: 14px; border: 1px solid rgba(61,35,24,.1); box-shadow: 0 14px 30px rgba(13,79,116,.2); }
.crop { object-fit: cover; object-position: 50% 50%; }
.panel { background: rgba(255,255,255,.88); border: 1px solid rgba(61,35,24,.1); border-radius: 16px; padding: 14px 16px; }
.card { position: relative; background: rgba(255,255,255,.88); border: 1px solid rgba(61,35,24,.1); border-radius: 16px; padding: 10px 12px 12px; }
.card p { font-size: 12.5px; line-height: 1.5; color: #6b4a3a; margin: 0; }
.card .art { display: block; width: 100%; height: 200px; object-fit: contain; border-radius: 10px; background: radial-gradient(70% 70% at 50% 60%, #ffffff, #d3effc 85%); }
.card .art.map { object-fit: cover; }
.zoom { position: relative; height: 200px; overflow: hidden; border-radius: 10px; background: #e8f6fd; }
.zoom img { position: absolute; width: 250%; }
.step { display: inline-block; margin-top: 8px; padding: 2px 9px; border-radius: 999px; background: #ffc44d; color: #1a1206; font-size: 10.5px; font-weight: 600; }
.stat { display: inline-block; margin: 0 7px 7px 0; padding: 7px 12px; border-radius: 12px; background: rgba(255,255,255,.88); border: 1px solid rgba(61,35,24,.1); font-size: 12px; color: #6b4a3a; }
.stat b { display: block; font-size: 20px; letter-spacing: -.02em; color: #3d2318; }
.stat.hot b { color: #c23a3a; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
td, th { padding: 5px 8px; border-bottom: 1px solid rgba(61,35,24,.1); text-align: left; vertical-align: top; }
th { font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: #957563; font-weight: 600; }
code { font-size: 11px; color: #0d4f74; }
.flow { display: flex; align-items: stretch; gap: 7px; margin: 2px 0 10px; }
.flow div { flex: 1; background: rgba(255,255,255,.88); border: 1px solid rgba(61,35,24,.1); border-radius: 12px; padding: 9px 11px; font-size: 12px; line-height: 1.4; color: #6b4a3a; }
.flow div b { display: block; font-size: 13px; margin-bottom: 2px; }
.flow div.lux { background: linear-gradient(140deg, rgba(160,130,255,.18), rgba(79,179,255,.12)); border-color: rgba(170,150,255,.4); }
.flow span { align-self: center; color: #b8650d; font-weight: 700; }
.timeline { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
.timeline .day { background: rgba(255,255,255,.88); border: 1px solid rgba(61,35,24,.1); border-radius: 14px; padding: 11px 12px; font-size: 11.5px; line-height: 1.45; color: #6b4a3a; }
.timeline .day b.date { display: inline-block; margin-bottom: 5px; padding: 1px 9px; border-radius: 999px; background: #2f8fe0; color: #ffffff; font-size: 10.5px; }
.timeline .day.now b.date { background: #ffc44d; color: #1a1206; }
figure { margin: 0; } figcaption { font-size: 11px; color: #957563; margin-top: 4px; }
.renders { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.renders img { width: 100%; height: 150px; object-fit: contain; border-radius: 12px; background: radial-gradient(70% 70% at 50% 60%, #ffffff, #d3effc 85%); }
.foot { position: absolute; left: 50px; right: 50px; bottom: 12px; font-size: 10px; color: #957563; }
.cover h1 { font-size: 46px; line-height: 1.08; margin: 4px 0 14px; }
.quote { font-size: 15px; color: #b8650d; border-left: 3px solid #e8a33a; padding-left: 12px; margin: 10px 0; }
</style></head><body>

${slide('Project report', '', `
<div class="grid g45" style="height:610px; align-items:center">
  <div>
    <p class="kick">Flood impact simulator</p>
    <h1>See what the storm does to your street — before it comes.</h1>
    <p class="lede">Pick a place and a storm. Water spreads across real terrain hour by hour, buildings, roads and schools light up as it reaches them, and <b>Aholo Lux3D</b> puts the things you own into the water at true scale. Then Waterline shows the way to higher ground.</p>
    <div style="margin-top:12px"><span class="stat"><b>${endpointsUsed.size + 2}</b>Aholo endpoints used</span><span class="stat"><b>3.2 km²</b>terrain simulated at 20 m</span><span class="stat"><b>5</b>storm scenarios</span><span class="stat"><b>2</b>real floods replayed</span></div>
  </div>
  ${img('report/sim-paiporta-overview.jpg', 'Paiporta at the peak of the October 2024 storm replay', 'shot')}
</div>
<p class="foot">Waterline · Manycore Aholo Global 3D AI Hackathon 2026 · A simulation for planning and awareness, not an official warning.</p>`, 'cover')}

${slide('The problem', 'Flood maps show a blue patch.<br>People underestimate it.', `
<div class="grid g37">
  <div>
    <p class="lede">Warnings speak in millimetres, return periods and metres. People think in cars, doors, streets and their own height — and they underestimate moving water.</p>
    <div class="panel small" style="margin:10px 0">
      <p><b>15 cm</b> of moving water can knock an adult over. <b>30 cm</b> floats most cars. <b>60 cm</b> sweeps away SUVs. <span class="muted">(US National Weather Service)</span></p>
      <p><b>Kerrville, Texas, 4 July 2025:</b> the Guadalupe rose about 8 m in 45 minutes; more than 100 people died in Kerr County.</p>
      <p style="margin:0"><b>Valencia, Spain, 29 October 2024:</b> about 230 died. In Paiporta, people were trapped going to get their cars out of garages.</p>
    </div>
    <p class="quote">Waterline turns a forecast into a picture of your street — with your own things in the water — so the danger lands before the water does.</p>
  </div>
  ${img('report/sim-paiporta-street.jpg', 'Street-level replay in Paiporta', 'shot')}
</div>`)}

${slide('How it works', 'A storm desk for your street.', `
<div class="grid g4">
  ${card('01 · Storm', 'Pick a place and a storm', 'Search any street or use your location. Then: today’s forecast, a replay of a real flood with its recorded rainfall, a JRC river flood, a cloudburst or a storm surge.', zoom('report/sim-houston.jpg', 'Houston cloudburst what-if', 'left:-60%; top:-12%'))}
  ${card('02 · Simulate', 'Watch the area flood', 'Water spreads over 1.8 × 1.8 km of real terrain, hour by hour, on a weather-style timeline you can play or drag.', zoom('report/sim-kerrville.jpg', 'Kerrville river corridor at the peak', 'left:-110%; top:-2%'))}
  ${card('03 · Lux3D', 'Make it personal', 'Snap or describe your car, door or scooter. Lux3D builds it in about two minutes and Waterline stands it at true scale on your street.', zoom('report/sim-aftermath.jpg', 'Lux3D SUV after the flood', 'left:-125%; top:-30%'))}
  ${card('04 · Escape', 'Find a way out', 'The nearest ground 1 m above the flood, a real walking route, the water depth along it — and a Lux3D person who walks it.', zoom('report/sim-escape.jpg', 'Route to higher ground', 'left:-115%; top:-12%'))}
</div>
<p class="small muted" style="margin-top:12px">The impact report counts what goes under: buildings in water, ground floors flooded, kilometres of road cut, and named schools, clinics and substations with their depth. Inside your home, Aholo World shows the same water coming through the door.</p>`)}

${slide('The simulation', 'Real terrain, a sloping valley,<br>water that has to get there.', `
<div class="grid g37">
  <div class="panel small">
    <h2>Terrain</h2><p>90 × 90 samples of Cesium World Terrain (20 m cells), gaps patched, a 3×3 median filter to remove buildings baked into the terrain model.</p>
    <h2>Sloping valleys</h2><p>A plane fitted to the valley floor is removed (a relative elevation model), so one water level follows the valley’s slope instead of drowning everything downhill. Open water (sea, lagoon) is detected and left out.</p>
    <h2>Connected flooding</h2><p>A priority flood from the river channel or shore and from your spot gives every cell the level at which water reaches it — so any level, at any hour, renders instantly.</p>
    <h2>Storms over time</h2><p style="margin:0">Rain: runoff beyond what the drains carry, in a leaky reservoir, turned into a level by binary search. Replays: recorded rainfall drives a lagged rise and fall. River: a hydrograph to the JRC depth. Surge: tide + surge.</p>
  </div>
  <div>${img('report/sim-paiporta-overview.jpg', 'Depth colours at the peak in Paiporta', 'shot')}
    <p class="small muted" style="margin-top:8px">Paiporta at the peak of the replay: depth colours from ankle-deep (pale) to over head height (violet); red roads are cut, services carry their depth. ${esc(statLine(P))}.</p></div>
</div>`)}

${slide('Live data, robust by design', 'Every number comes from open data —<br>and keeps working when a service doesn’t.', `
<div class="grid g45">
  <div>
    <table>
      <tr><th>Data</th><th>Source</th></tr>
      <tr><td><b>Rain, wind</b> (forecast)</td><td>Open-Meteo Forecast API, hourly</td></tr>
      <tr><td><b>Recorded storms</b></td><td>Open-Meteo Historical Weather (ERA5 reanalysis)</td></tr>
      <tr><td><b>River discharge</b></td><td>Open-Meteo Flood API (GloFAS)</td></tr>
      <tr><td><b>Sea level</b></td><td>Open-Meteo Marine API</td></tr>
      <tr><td><b>River flood depths</b></td><td>JRC / Copernicus global flood hazard maps v2.1 (GeoTIFF range requests)</td></tr>
      <tr><td><b>Buildings, roads, services</b></td><td>OpenStreetMap via Overpass (three mirrors)</td></tr>
      <tr><td><b>3D city, terrain, search</b></td><td>Google Photorealistic 3D Tiles, Cesium World Terrain (Cesium ion)</td></tr>
      <tr><td><b>Walking routes</b></td><td>FOSSGIS OSRM on OpenStreetMap</td></tr>
    </table>
    <div class="panel small" style="margin-top:10px"><h2>Robustness</h2><p style="margin:0">The server caches every response on disk (30 min forecasts → 14 days of map data), fails over between Overpass mirrors, serves stale data when a service is down, and falls back to fixtures for the demo places — so the replays run offline. Every response says whether it is <i>live, cached, stale</i> or a <i>saved copy</i>, and the location card shows it.</p></div>
  </div>
  ${img('report/sim-houston.jpg', 'Houston with the live location card', 'shot')}
</div>`, 'alt')}

${slide('Real floods, replayed', 'Two real storms, replayed<br>over the real terrain.', `
<div class="grid g2">
  <figure>${img('report/sim-paiporta-overview.jpg', 'Paiporta replay at the peak', 'shot')}<figcaption><b>Paiporta, Spain · 29 Oct 2024.</b> ${esc(statLine(P))}. Water at the street peaks at the reported ${esc(P.depthAtSpot ?? 1.5)} m.</figcaption></figure>
  <figure>${img('report/sim-kerrville.jpg', 'Kerrville replay at the peak', 'shot')}<figcaption><b>Kerrville, Texas · 4 Jul 2025.</b> ${esc(statLine(K))}. The flood stays in the Guadalupe’s corridor; named riverside roads are cut.</figcaption></figure>
</div>
<div class="panel small" style="margin-top:12px"><b>Honest about the data:</b> the reanalysis record smooths cloudbursts — ${esc(P.rainMm ?? 124)} mm at Paiporta in ERA5 against 771 mm at the Turís gauge upstream — so a replay follows the recorded storm’s timing and is scaled to the depth reported in the street. The app says so on screen.</div>`)}

${slide('Aholo at the core', `${endpointsUsed.size + 2} Aholo endpoints. Every object<br>in the water is made by Aholo.`, `
<div class="grid" style="grid-template-columns: 64fr 36fr">
  <div class="panel" style="padding:8px 12px"><table>
    <tr><th>Lux3D</th><th>Where it shows up in Waterline</th><th>Task ids</th></tr>
    ${ENDPOINTS.map(([name, endpoint, where, tasks]) => `<tr><td style="white-space:nowrap"><b>${esc(name)}</b><br><code>${esc(endpoint)}</code></td><td>${esc(where)}</td><td class="muted" style="font-size:10.5px">${esc(tasks || '–')}</td></tr>`).join('')}
    <tr><td><b>Aholo World</b><br><code>world/v1/generations</code></td><td>A 3D room from one photo, flooded with the street’s water</td><td class="muted" style="font-size:10.5px">example room shipped</td></tr>
    <tr><td><b>Asset</b><br><code>asset/v1/token · upload</code></td><td>Photos and models sent to the services above (multipart for 5 MB+)</td><td></td></tr>
  </table></div>
  <div class="panel small">
    <h2>Live, inside the app</h2><p>Visitors make their own models (photo or words, about two minutes), rooms and AR exports. A small Node server keeps the API key off the browser, with per-visitor hourly and daily limits.</p>
    <h2>Measured, not decorative</h2><p>The water is always measured against a Lux3D model at its real height. ${lux.length} Library models (${fromPhoto.length} from CC0 photos, ${fromText.length} from text) and ${extras.length} extras made in ${extrasTasks} Lux3D tasks, each with task ids, prompts and SHA-256 in <code>library.json</code> and <code>extras.json</code>.</p>
    <h2>Why no Aholo “simulation API”?</h2><p style="margin:0">Aholo has none; the hydrology is Waterline’s own, driven by public data. Aholo makes the result personal.</p>
  </div>
</div>`)}

${slide('Lux3D, beyond 3D models', 'Mud, a walk, parts and a hinge —<br>all made with Lux3D.', `
<div class="renders">
  <figure>${img('report/asset-suv.png', 'Lux3D Family SUV')}<figcaption>Family SUV (text-to-3D)</figcaption></figure>
  <figure>${img('report/asset-suv-flooded.png', 'Lux3D material transfer: the SUV after the flood')}<figcaption>After the flood: multimodal-to-image → material transfer</figcaption></figure>
  <figure>${img('report/asset-suv-parts.png', 'Lux3D part-split SUV')}<figcaption>Part-split: body + four wheels</figcaption></figure>
  <figure>${img('report/asset-walker.png', 'Lux3D rigged walking person')}<figcaption>Rigged and retargeted to a walk cycle</figcaption></figure>
</div>
<div class="grid g3" style="margin-top:12px">
  <div class="panel small"><h2>What the water leaves</h2><p style="margin:0">A mud-stained reference image of the SUV (multimodal-to-image), then material transfer onto the same mesh. In the replay, once the water has reached the car and starts to fall, the muddy model swaps in.</p></div>
  <div class="panel small"><h2>A rig that said no</h2><p style="margin:0">Rigging refused the Library person: <i>arms down against the body, not a T- or A-pose</i>. So Lux3D made an A-pose image of the same person, image-to-3D built it, then rig and retarget gave it a walk — four tasks, about 3 minutes.</p></div>
  <div class="panel small"><h2>Take it home</h2><p style="margin:0">Multi-format export gives USDZ for AR Quick Look and STL for printing (80 mm miniatures). Any placed object can be exported live from the app.</p></div>
</div>
<div class="grid g2" style="margin-top:12px; gap:12px">
  <figure>${img('report/sim-aftermath.jpg', 'The mud-stained SUV in the app after the water drops', 'shot crop" style="height:150px; object-position: 70% 55%')}<figcaption>In the app: the water drops to 0.48 m and the Lux3D “after the flood” SUV swaps in.</figcaption></figure>
  <figure>${img('report/sim-lux3d.jpg', 'The Lux3D space in the app', 'shot crop" style="height:150px; object-position: 0 40%')}<figcaption>The Lux3D space: Library, photo and text generation, and the extras with downloads.</figcaption></figure>
</div>`, 'alt')}

${slide('Lux3D lessons', 'What each Lux3D model taught us.', `
<div class="grid g3">
  <div class="card"><div class="renders" style="grid-template-columns:1fr 1fr">${img('report/asset-picnic-table.png', 'First Lux3D test: a picnic table')}${img('report/asset-suv.png', 'Family SUV')}</div>
    <span class="step">14 Nov · scale</span><h3>Scale must be decided</h3>
    <p>The first photo model came back in estimated metres, the first text model in a 10-unit box. Every model is scaled to a real height: your choice → your words (“pickup” = 1.8 m) → Lux3D’s metres when they look real.</p></div>
  <div class="card"><div class="renders" style="grid-template-columns:1fr 1fr">${img('report/asset-pickup.png', 'Lux3D: a red pickup truck')}${img('report/asset-camera.png', 'Lux3D: asdfghjkl became a camera')}</div>
    <span class="step">16 Nov · live test</span><h3>“a red pickup truck” and “asdfghjkl”</h3>
    <p>The truck came back 4.8 m tall in a 12-unit box; the nonsense became a 17 cm camera. Hence Auto size and tappable example ideas.</p></div>
  <div class="card"><div class="renders" style="grid-template-columns:1fr 1fr">${img('report/asset-door-v1.png', 'Photo-made door')}${img('report/asset-door-v2.png', 'Text-made door')}</div>
    <span class="step">16 Nov · rejected</span><h3>Door v1 → v2, and 280k → 60k faces</h3>
    <p>From a photo, the door became a one-sided slab; rebuilt from text it is clean from every side. A 60,000-face budget keeps a street of objects light.</p></div>
</div>`)}

${slide('A way out', 'Then it shows the way<br>to higher ground.', `
<div class="grid g2">
  <div>${img('report/sim-escape.jpg', 'Route to higher ground in Paiporta', 'shot')}<p class="small muted" style="margin-top:6px">${esc(stats.escape ?? 'Higher ground and a walking route')}, found at the first 40 cm of the rising water: leave early.</p></div>
  <div>
    <ul>
      <li>Searches Cesium World Terrain ring by ring for the nearest ground at least 1 m above the flood, ignoring roof-sized bumps.</li>
      <li>Gets a real walking route there (OSRM on OpenStreetMap) and reports distance, minutes on foot and the water depth along the way.</li>
      <li>A Lux3D person — rigged and animated by Lux3D — walks the route, with a chase camera.</li>
      <li>Plain advice: go early; never go back for your car or into underground garages; if cut off, go to the highest floor.</li>
    </ul>
    ${img('report/sim-walker.jpg', 'The Lux3D walker on the route', 'shot crop" style="height:230px;margin-top:10px')}
  </div>
</div>`)}

${slide('Aholo World · inside your home', 'Then the water comes inside.', `
<div class="flow">
  <div><b>One photo</b>of a room, or a description</div><span>→</span>
  <div class="lux"><b>Aholo World</b>builds the room in 3D as Gaussian splats (SPZ), in about 10 minutes</div><span>→</span>
  <div><b>Scale</b>to the ceiling height you give (one photo has no true size)</div><span>→</span>
  <div><b>Same flood</b>the street’s water, minus how far your floor sits above the street</div>
</div>
<div class="grid" style="grid-template-columns: 36fr 64fr">
  <div class="panel small">
    <p style="margin-top:0">Everything below the waterline turns muddy, and the panel says what that depth means indoors: sockets at about 30 cm, furniture, when to go upstairs.</p>
    <p>An example living room ships with the app; your own room keeps building even if you close the page. Shown with three.js and Spark.</p>
    <p style="margin:0"><b>Iterations:</b> a panorama crop failed in 7 s; an ordinary 4:3 photo built a room in about 8 minutes, so the app now always sends an ordinary photo about 1280 px across.</p>
  </div>
  ${img('report/sim-room.jpg', 'Aholo World room with water coming in', 'shot')}
</div>`, 'alt')}

${slide('Design', 'A weather desk, not a form.', `
<div class="grid" style="grid-template-columns: 62fr 38fr">
  <div>${img('report/sim-home.jpg', 'Homepage', 'shot crop" style="height:300px; object-position: 50% 0')}
    ${img('report/sim-paiporta-street.jpg', 'The storm desk', 'shot crop" style="height:250px; margin-top:12px; object-position: 50% 100%')}
  </div>
  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; align-items:start">
    ${img('report/sim-phone.jpg', 'Phone layout', 'shot')}
    <div class="panel small"><h2>Conventions people know</h2><p>Map first; a location card; a layer rail; a depth legend; a timeline with hourly rain bars and play. Original design and code — no assets from any weather site.</p><h2>Readable data</h2><p style="margin:0">Tabular numbers, red for what is cut or under, honest status for every source.</p></div>
  </div>
</div>`)}

${slide('Development process', 'Six days, built and rebuilt by testing.', `
<div class="timeline">
  <div class="day"><b class="date">14 Nov</b><br><b>Working core.</b> Lux3D client (upload, create, poll, download); a real 3D street with a rising water level; real JRC flood depths and a higher-ground finder.</div>
  <div class="day"><b class="date">15 Nov</b><br><b>A demo that always works.</b> Studio street without a map account; depth challenge; move, duplicate, undo; share links; a browser test suite.</div>
  <div class="day"><b class="date">16 Nov</b><br><b>Lux3D everywhere.</b> Six Library models; lighter textures; Auto size after a live test. User test: “it doesn’t seem functional” → the demo starts itself.</div>
  <div class="day"><b class="date">17 Nov</b><br><b>Finishing v1.</b> Homepage, captioned demo video and report captured from the running app.</div>
  <div class="day"><b class="date">18 Nov</b><br><b>Anywhere, then inside.</b> “I can’t put in my location” → search and Use my location. Aholo World rooms.</div>
  <div class="day now"><b class="date">19 Nov</b><br><b>From a picture to a simulator.</b> Terrain flood model, live weather and storm replays, OpenStreetMap impacts, a storm-desk UI, and seven more Lux3D capabilities; then the sky-and-cream look restored and a homepage whose flooded car shatters as you scroll.</div>
</div>
<div class="panel small" style="margin-top:14px"><b>Biggest lesson of the last day:</b> a flat “bathtub” on sloping ground drowned all of Paiporta 11 m deep, and the terrain model carried buildings 4 m above the street. Detrending the valley, filtering building bumps and reading depth beside each building brought it to the scale of the real event — checked against both replays before anything was drawn.</div>
<div class="grid g4" style="margin-top:14px; gap:12px">
  <figure>${img('report/ui-v1.jpg', 'Interface v1', 'shot crop" style="height:150px; object-position: 0 0')}<figcaption>v1 · a long sidebar form</figcaption></figure>
  <figure>${img('report/ui-v2.jpg', 'Interface v2', 'shot crop" style="height:150px; object-position: 0 0')}<figcaption>v2 · dark, map-first, live impact panel</figcaption></figure>
  <figure>${img('report/app-things.jpg', 'Interface v3', 'shot crop" style="height:150px; object-position: 0 0')}<figcaption>v3 · sky and cream, one space per function</figcaption></figure>
  <figure>${img('report/sim-paiporta-overview.jpg', 'Interface v4', 'shot crop" style="height:150px; object-position: 0 0')}<figcaption>v4 · the storm simulator, back in sky and cream</figcaption></figure>
</div>`, 'alt')}

${slide('Build and tools', 'How it is built, and with what.', `
<div class="grid g37">
  <div class="panel small">
    <h2>Architecture</h2>
    <p>Browser: CesiumJS 1.145 and plain JavaScript modules, no build step. Server: a zero-framework Node app that proxies Aholo (key server-side, with quotas), weather, OpenStreetMap, JRC data and routing, with a disk cache and fixtures.</p>
    <h2>Quality</h2>
    <p style="margin:0">${testCount} automated tests (simulation maths, data layer failover, Lux3D client and export routes, server) and browser checks in Microsoft Edge, including a full offline run of the 3D engine with every external request blocked. Every screenshot here is of the running app; asset pictures are renders of the actual Lux3D files.</p>
  </div>
  <div class="panel" style="padding:8px 14px"><table>
    <tr><th>Tool</th><th>Used for</th></tr>
    <tr><td><b>Aholo Lux3D API</b></td><td>3D models (image/text), multimodal-to-image, material transfer, rigging + retargeting, part-split, articulation, multi-format export</td></tr>
    <tr><td><b>Aholo World API</b> · Asset</td><td>3D rooms (Gaussian splats) from a photo · uploads</td></tr>
    <tr><td>CesiumJS · Cesium ion</td><td>Google Photorealistic 3D Tiles, Cesium World Terrain, place search</td></tr>
    <tr><td>Open-Meteo (ERA5, GloFAS, Marine)</td><td>Forecasts, recorded storms, river discharge, sea level</td></tr>
    <tr><td>OpenStreetMap · Overpass · OSRM</td><td>Buildings, roads, services; walking routes</td></tr>
    <tr><td>JRC / Copernicus EMS</td><td>Global river flood hazard maps v2.1 (geotiff.js)</td></tr>
    <tr><td>three.js · Spark (MIT)</td><td>Showing Aholo World rooms</td></tr>
    <tr><td>Microsoft Zira (Windows text-to-speech)</td><td>The demo video’s voice-over</td></tr>
    <tr><td>Playwright + Microsoft Edge · model-viewer</td><td>Tests, screenshots, this PDF, the demo video · renders</td></tr>
    <tr><td><b>Claude Code (Anthropic)</b>, an AI coding assistant</td><td>Wrote most of the code and tests and drafted this report, under the participant’s direction: concept, design references, decisions and user testing</td></tr>
  </table></div>
</div>`)}

${slide('Limits and next steps', 'Honest about what it is, and is not.', `
<div class="grid g2">
  <div class="panel small"><h2>Limits</h2><ul>
    <li>A connected “bathtub” on a detrended terrain model: no flow speed, walls or drains beyond the scenario curves. A planning tool, not a forecast.</li>
    <li>Cesium World Terrain is ~30 m data and carries buildings in dense towns; depths at street scale are estimates. In Lagos it runs ~5 m above the 3D city’s streets, so Waterline falls back to the terrain’s own low ground there.</li>
    <li>ERA5 smooths cloudbursts; replays are scaled to the reported depth. JRC covers river floods only (~90 m cells).</li>
    <li>OpenStreetMap coverage varies; Overpass can be slow, so caches and fixtures back it up.</li>
    <li>AI sizes are estimates the app shows and lets you correct. Higher ground is planning help, not an evacuation order.</li>
  </ul></div>
  <div class="panel small"><h2>Next</h2><ul>
    <li><b>Official warnings</b> (national weather services) beside the simulation, and push alerts for your saved street.</li>
    <li><b>Aholo World reconstruction:</b> a phone video of your ground floor for a true-scale room; <b>SpatialUnderstanding</b> to find the sockets and sofa, so the water reads “over the sofa”.</li>
    <li><b>Lux3D part-split in the report:</b> “wheels under, engine bay next”.</li>
    <li>Community flood marks (“the water reached here in 2024”) and more languages.</li>
    <li>A shallow-water solver on the GPU for flow and timing.</li>
  </ul></div>
</div>
<p class="foot">Credits: Aholo Lux3D, World and Asset (Manycore) · CesiumJS (Apache-2.0) · Google Photorealistic 3D Tiles via Cesium ion · Open-Meteo (CC BY 4.0), ERA5 and GloFAS (Copernicus) · JRC / Copernicus EMS (CC BY 4.0) · © OpenStreetMap contributors (ODbL) · US NWS · Poly Haven (CC0) · Poppins (SIL OFL). Full list in THIRD_PARTY_NOTICES.txt.</p>`)}
</body></html>`;

const reportPath = path.join(out, 'project-report.html');
await fs.writeFile(reportPath, html);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const report = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await report.goto(pathToFileURL(reportPath).href);
  await report.evaluate(() => document.fonts.ready);
  const overflow = await report.locator('section').evaluateAll((nodes) => nodes.map((n, i) => [i + 1, n.scrollHeight]).filter(([, h]) => h > 721));
  if (overflow.length) throw new Error(`Report pages overflow 720px: ${JSON.stringify(overflow)}`);
  const broken = await report.locator('img').evaluateAll((nodes) => nodes.filter((n) => !(n.complete && n.naturalWidth > 0)).map((n) => n.getAttribute('src')));
  if (broken.length) throw new Error(`Report images did not load: ${broken.join(', ')}`);
  await report.pdf({ path: path.join(out, 'Waterline-project-report.pdf'), printBackground: true, preferCSSPageSize: true });
} finally { await browser.close(); }
const pdf = await fs.readFile(path.join(out, 'Waterline-project-report.pdf'));
const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
if (pages !== pageNo) throw new Error(`Expected a ${pageNo}-page PDF, got ${pages}.`);

// ---------- checklist, X post draft, source archive ----------
const has = (file) => fs.stat(path.join(out, file)).then((s) => s.size > 0, () => false);
await fs.writeFile(path.join(out, 'submission-checklist.json'), JSON.stringify({
  officialEvent: 'https://www.aholo.ai/hackathon', submissionPortal: 'https://www.aholo.ai/hackathon (My Submission)',
  deadlineUtc: '2026-11-19T11:00:00Z', deadlineLagos: '19 November 2026 at 12:00 noon', deadlineEst: '19 November 2026 at 06:00 EST',
  required: ['Project report (PDF or PPT)', 'Working demo: a link, or a video showing the actual project running'],
  bonus: ['Public X post with #Manycorehackathon (5% of the expert score)', 'Source code'],
  ready: [`Project report PDF (${pageNo} pages)`, 'Lux3D evidence for every Library model and extra', 'Source archive',
    ...((await has('waterline-demo.webm')) ? ['Demo video (WebM): review before uploading'] : []),
    ...((await has('waterline-demo.mp4')) ? ['Demo video (MP4 copy) for forms that need MP4'] : [])],
  participantActions: ['Confirm registration and team (solo counts) in the official portal.', 'Check the tools list in the report and add any other tool you used.',
    'Upload the report and the demo video (or a working hosted link) to My Submission before the deadline.',
    'Post on X with #Manycorehackathon and add the link.', 'Push the source to GitHub if you want to share it (it is not pushed by these scripts).'],
  submission: 'Not submitted by this script.',
}, null, 2));
// X counts most characters as 1 (emoji as 2); keep the main post within 280 with room for a link.
const post = [
  'Flood maps show a blue patch. Waterline shows what the storm does to YOUR street, before it comes 🌧️',
  '',
  'Live rain + real terrain + OpenStreetMap, hour by hour. Aholo Lux3D puts your own car in the water at true scale.',
  '',
  '#Manycorehackathon #Lux3D',
].join('\n');
const reply = 'Replays of Valencia 2024 and Kerrville 2025, buildings and roads that go under, the mud Lux3D material transfer leaves on your car, and a Lux3D-rigged person who walks you to higher ground.';
const xLength = (text) => [...text].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2fff ? 2 : 1), 0);
if (xLength(post) + 24 > 280) throw new Error(`X post is ${xLength(post)} characters; keep it under 256 to leave room for a link.`);
if (xLength(reply) > 280) throw new Error(`X reply is ${xLength(reply)} characters.`);
await fs.writeFile(path.join(out, 'x-post-draft.txt'), [
  `POST (${xLength(post)} characters + a link or the attached demo video):`, '', post, '',
  `OPTIONAL REPLY (${xLength(reply)} characters):`, '', reply, '',
].join('\n'));
const tests = (await fs.readdir('test')).filter((name) => name.endsWith('.mjs')).map((name) => `test/${name}`);
const includes = ['package.json', 'package-lock.json', 'server.mjs', 'lib', 'public', 'scripts', 'data', 'docs', ...tests, 'README.md', '.env.example', '.gitignore', 'Dockerfile', '.dockerignore', 'THIRD_PARTY_NOTICES.txt'];
const present = [];
for (const item of includes) if (await fs.stat(path.join(root, item)).then(() => true, () => false)) present.push(item);
// Relative, forward-slash paths: GNU tar would read "C:\..." as a remote host.
const archived = spawnSync('tar', ['-czf', 'submission/waterline-source.tar.gz', '--exclude=public/models/generated/*.glb', '--exclude=public/models/generated/exports', ...present], { cwd: root, encoding: 'utf8' });
if (archived.status !== 0) throw new Error(`Source archive failed: ${archived.stderr}`);
const listing = spawnSync('tar', ['-tzf', 'submission/waterline-source.tar.gz'], { cwd: root, encoding: 'utf8' }); // relative: GNU tar reads C: as a host
if (listing.status !== 0 || listing.stdout.split(/\r?\n/).some((name) => /(^|\/)\.env$|node_modules|\.waterline|Screenshot_/.test(name))) throw new Error('Archive validation failed.');
console.log(`Prepared a ${pageNo}-page report, Lux3D evidence, checklist, X draft and source archive in submission/. Nothing was submitted or posted.`);
