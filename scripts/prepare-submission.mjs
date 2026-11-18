// Builds the submission package in submission/: the project report (PDF, 16:9 deck), Lux3D asset
// evidence, a checklist, an X post draft and the source archive. It does not register, publish,
// post or submit anything. Run scripts/capture-report.mjs first for fresh screenshots.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { measureGlb } from '../public/glb-measure.js';

const root = path.resolve('.'), out = path.join(root, 'submission');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------- Lux3D evidence: every shipped Library model, verified against its file ----------
const library = JSON.parse(await fs.readFile('public/models/library.json', 'utf8'));
const evidence = [];
for (const entry of library) {
  const bytes = await fs.readFile(path.join('public', entry.url));
  const bounds = measureGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const shipped = sha256(bytes);
  if (entry.generation?.shipped?.sha256 && entry.generation.shipped.sha256 !== shipped) throw new Error(`${entry.id}: file does not match library.json`);
  evidence.push({ ...entry, shippedFile: { bytes: bytes.length, sha256: shipped, gltfSize: bounds.size.map((v) => +v.toFixed(3)) } });
}
await fs.writeFile(path.join(out, 'lux3d-evidence.json'), JSON.stringify(evidence, null, 2));
const lux = evidence.filter((e) => e.source?.startsWith('lux3d'));
const fromPhoto = lux.filter((e) => e.source === 'lux3d-image-to-3d');
const fromText = lux.filter((e) => e.source === 'lux3d-text-to-3d');
const mb = (n) => (n / 1e6).toFixed(1);
const originalTotal = lux.reduce((s, e) => s + (e.generation?.fileBytes ?? 0), 0);
const shippedTotal = lux.reduce((s, e) => s + e.shippedFile.bytes, 0);

// ---------- the report (16:9 deck) ----------
const esc = (t) => String(t).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const img = (src, alt, cls = '') => `<img class="${cls}" src="${src}" alt="${esc(alt)}">`;
let pageNo = 0;
const slide = (kicker, title, body, cls = '') => `<section class="${cls}"><div class="top"><span class="logotype">WATERLINE</span><span class="pill">${++pageNo} · ${kicker}</span></div><h1>${title}</h1>${body}</section>`;
const card = (step, title, text, picture) => `<div class="card">${picture ?? ''}<span class="step">${step}</span><h3>${title}</h3><p>${text}</p></div>`;

const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
const libraryRows = lux.map((e) => `<tr><td><img class="thumb" src="../public${esc(e.thumbnail ?? '')}" alt=""></td><td style="white-space:nowrap"><b>${esc(e.name)}</b><br><span class="muted">${e.source === 'lux3d-image-to-3d' ? 'Photo → 3D' : 'Text → 3D'} · ${e.realHeight} m · task ${esc(e.taskId)}</span></td><td class="muted">${esc(clip(e.generation?.prompt ? `“${e.generation.prompt}”` : (e.generation?.sourceImage?.credit ? `CC0 photo by ${e.generation.sourceImage.credit}` : 'Text prompt (first model, before prompts were recorded)'), 78))}</td></tr>`).join('');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Waterline: project report</title><style>
@font-face { font-family: 'Cinzel Decorative'; font-weight: 700; src: url('../public/fonts/cinzel-decorative-700.woff2'); }
@font-face { font-family: 'Poppins'; font-weight: 400; src: url('../public/fonts/poppins-400.woff2'); }
@font-face { font-family: 'Poppins'; font-weight: 500; src: url('../public/fonts/poppins-500.woff2'); }
@font-face { font-family: 'Poppins'; font-weight: 600; src: url('../public/fonts/poppins-600.woff2'); }
@font-face { font-family: 'Allura'; src: url('../public/fonts/allura-400.woff2'); }
@page { size: 1280px 720px; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font: 15px/1.5 Poppins, sans-serif; color: #3d2318; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
section { position: relative; width: 1280px; height: 720px; padding: 34px 54px 30px; overflow: hidden; break-after: page;
  background: radial-gradient(70% 60% at 100% 0%, rgba(255,255,255,.6), transparent 70%), linear-gradient(180deg, #bfe6fa, #e4f4fd 62%, #fdf2df); }
section:last-child { break-after: auto; }
section.cream { background: radial-gradient(60% 50% at 0% 0%, rgba(255,255,255,.7), transparent 70%), linear-gradient(180deg, #fbe6c4, #fdf2df); }
.top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
.logotype { font-weight: 500; font-size: 18px; letter-spacing: .38em; }
.pill { padding: 5px 14px; border-radius: 999px; background: rgba(46,64,74,.8); color: #fff; font-size: 12px; font-weight: 500; }
h1 { margin: 0 0 14px; font: 700 40px/1.05 'Cinzel Decorative', serif; text-transform: uppercase; letter-spacing: -.5px; }
h2 { margin: 0 0 6px; font: 600 13px Poppins; letter-spacing: 1.4px; text-transform: uppercase; color: #0d4f74; }
h3 { margin: 4px 0 4px; font: 600 16px/1.3 Poppins; }
p { margin: 0 0 9px; } ul { margin: 0; padding-left: 18px; } li { margin: 0 0 6px; }
.lede { font-size: 18px; line-height: 1.5; color: #5a3a2c; }
.script { font: 40px/1 Allura, cursive; color: #6b4a3a; margin: 0 0 4px; }
.muted { color: #8a6c5c; }
.small { font-size: 12.5px; }
.grid { display: grid; gap: 22px; }
.g2 { grid-template-columns: 1fr 1fr; } .g37 { grid-template-columns: 37fr 63fr; } .g45 { grid-template-columns: 44fr 56fr; } .g3 { grid-template-columns: repeat(3, 1fr); }
.shot { display: block; width: 100%; border-radius: 16px; box-shadow: 0 12px 30px rgba(13,79,116,.18); background: #fff; }
.shot.h { height: 100%; object-fit: cover; object-position: left top; }
.panel { background: rgba(255,255,255,.82); border-radius: 18px; padding: 16px 18px; box-shadow: 0 8px 20px rgba(13,79,116,.1); }
.card { position: relative; background: rgba(255,255,255,.85); border-radius: 20px; padding: 12px 14px 14px; box-shadow: 0 8px 20px rgba(13,79,116,.1); }
.card p { font-size: 13px; line-height: 1.5; color: #5a3a2c; margin: 0; }
.card .art { display: block; width: 100%; height: 250px; object-fit: contain; border-radius: 12px; background: radial-gradient(70% 70% at 50% 60%, #fff, #d5f0fc 85%); }
.card .art.map { object-fit: cover; object-position: 78% 45%; }
.card .art.cream { background: radial-gradient(70% 70% at 50% 60%, #fff, #fbe3bd 85%); }
.step { display: inline-block; margin-top: 8px; padding: 2px 10px; border-radius: 999px; background: #fbe3bd; font-size: 11px; font-weight: 600; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.pair img { width: 100%; height: 170px; object-fit: contain; border-radius: 12px; background: radial-gradient(70% 70% at 50% 60%, #fff, #d5f0fc 85%); }
.pair img.photo { object-fit: cover; }
.arrow { font-weight: 600; color: #0d4f74; }
.big { font: 600 44px/1 Poppins; letter-spacing: -1.5px; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
td, th { padding: 4px 8px; border-bottom: 1px solid rgba(61,35,24,.1); text-align: left; vertical-align: middle; }
th { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #8a6c5c; font-weight: 600; }
.thumb { width: 52px; height: 38px; object-fit: contain; border-radius: 8px; background: radial-gradient(#fff, #d5f0fc); }
.flow { display: flex; align-items: stretch; gap: 8px; margin: 2px 0 10px; }
.flow div { flex: 1; background: #fff; border-radius: 14px; padding: 10px 12px; font-size: 12.5px; line-height: 1.4; box-shadow: 0 6px 14px rgba(13,79,116,.08); }
.flow div b { display: block; font-size: 13.5px; margin-bottom: 2px; }
.flow div.lux { background: linear-gradient(140deg, #efe8ff, #dff3ff); border: 1.5px solid #c9b8ff; }
.flow span { align-self: center; color: #0d4f74; font-weight: 700; }
.timeline { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.timeline .day { background: rgba(255,255,255,.85); border-radius: 18px; padding: 14px 16px; font-size: 12.5px; line-height: 1.45; }
.timeline .day b.date { display: inline-block; margin-bottom: 6px; padding: 2px 10px; border-radius: 999px; background: #0d4f74; color: #fff; font-size: 11px; }
.ui3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 14px; }
.ui3 figure { margin: 0; } .ui3 img { width: 100%; height: 170px; object-fit: cover; object-position: left top; border-radius: 12px; box-shadow: 0 8px 18px rgba(13,79,116,.15); }
figcaption { font-size: 11.5px; color: #6b4a3a; margin-top: 4px; }
.cover h1 { font-size: 64px; margin: 6px 0 16px; }
.stat { display: inline-block; margin: 0 8px 8px 0; padding: 8px 14px; border-radius: 14px; background: #fff; font-size: 13px; box-shadow: 0 6px 14px rgba(13,79,116,.08); }
.stat b { display: block; font-size: 22px; letter-spacing: -.5px; }
.hero-art { position: relative; height: 560px; border-radius: 28px; overflow: hidden; background: linear-gradient(180deg, #8fd3f4, #c8ebfb); box-shadow: 0 16px 40px rgba(13,79,116,.2); }
.hero-art .car { position: absolute; left: 0; top: 17%; width: 100%; height: 68%; object-fit: contain; z-index: 2; filter: drop-shadow(0 22px 26px rgba(13,79,116,.25)); }
.hero-art .water { position: absolute; left: 0; right: 0; top: 55%; bottom: 0; z-index: 3; background: linear-gradient(180deg, rgba(47,159,219,.55), rgba(13,79,116,.75));
  -webkit-mask-image: linear-gradient(180deg, #000 60%, rgba(0,0,0,.85)); }
.hero-art .line { position: absolute; left: 0; right: 0; top: 55%; height: 3px; z-index: 4; background: rgba(255,255,255,.85); }
.hero-art .tag { position: absolute; z-index: 5; right: 5%; top: 47%; padding: 8px 18px; border-radius: 999px; background: #fff; font-weight: 600; font-size: 15px; box-shadow: 0 6px 16px rgba(13,79,116,.15); }
.hero-art .sky { position: absolute; left: 7%; top: 7%; z-index: 5; font: 34px/1.1 Allura, cursive; color: #3d2318; }
.hero-art .cloud { position: absolute; z-index: 1; width: 220px; height: 70px; border-radius: 70px; background: #fff; opacity: .7; filter: blur(8px); }
.card .big, .big { font: 600 46px/1.05 Poppins; letter-spacing: -1.5px; color: #3d2318; }
.strip { position: absolute; left: 54px; right: 54px; bottom: 70px; display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
.strip img { width: 100%; height: 120px; object-fit: contain; border-radius: 16px; background: radial-gradient(70% 70% at 50% 60%, #fff, #d5f0fc 85%); }
.foot { position: absolute; left: 54px; right: 54px; bottom: 16px; font-size: 10.5px; color: #8a6c5c; }
</style></head><body>

${slide('Project report', '', `
<div class="grid g45" style="height:600px">
  <div style="padding-top:20px">
    <p class="script">before the water comes…</p>
    <h1 style="font-size:54px;margin:4px 0 14px">See the water.<br>Understand the impact.</h1>
    <p class="lede">A flood map shows a blue patch. <b>Waterline</b> shows the water at <i>your</i> car’s windows, on <i>your</i> street.</p>
    <p class="lede">Visitors snap or describe the things they own, <b>Aholo Lux3D</b> turns them into 3D models, and Waterline stands them at true scale in a photorealistic 3D city. Then the water rises, beside real flood data and a walking route to higher ground.</p>
    <div style="margin-top:14px;display:flex;gap:8px"><span class="stat"><b>${lux.length}</b>Lux3D Library models</span><span class="stat"><b>~2 min</b>photo or words → 3D</span><span class="stat"><b>2 cities</b>real flood stories</span></div>
  </div>
  <div class="hero-art"><span class="cloud" style="left:8%;top:12%"></span><span class="cloud" style="right:6%;top:20%;width:160px"></span>
    <span class="sky">your car, your street…</span>
    <img class="car" src="../public/img/hero-family-suv.png" alt="Lux3D Family SUV"><div class="water"></div><div class="line"></div>
    <span class="tag">Water at 1.2 m · up to the windows</span></div>
</div>
<p class="foot">Waterline · Manycore Aholo Global 3D AI Hackathon 2026 · Illustration, not a forecast.</p>`, 'cover')}

${slide('The problem', '1.2 metres means nothing<br>until you see it.', `
<div class="grid g37">
  <div>
    <p class="lede">Flood warnings speak in metres and return periods. People think in cars, doors and their own height, and they underestimate moving water.</p>
    <div class="panel small" style="margin:10px 0">
      <p><b>15 cm</b> of moving water can knock an adult over. <b>30 cm</b> floats most cars. <b>60 cm</b> sweeps away SUVs. <span class="muted">(US National Weather Service)</span></p>
      <p><b>Kerrville, Texas, 4 July 2025:</b> the Guadalupe rose about 8 m (26 ft) in 45 minutes; more than 100 people died in Kerr County.</p>
      <p style="margin:0"><b>Valencia, Spain, 29 October 2024:</b> about 230 died across Spain. In Paiporta, people were trapped going to get their cars out of garages.</p>
    </div>
    <p>Waterline puts that number next to something you recognise, so the danger lands <b>before</b> the water does.</p>
  </div>
  ${img('report/app-studio-lineup.jpg', 'Six Lux3D objects in 0.9 m of water with live impact statuses', 'shot')}
</div>
<p class="foot">Every object in the picture is an Aholo Lux3D model at its real height, in 0.9 m of water. The panel reads it out: the small car is up to its windows, the adult waist-deep, the bin 84% under.</p>`)}

${slide('How it works', 'Snap it. Place it.<br>Raise the water.', `
<div class="grid g3">
  ${card('01 · Lux3D', 'Snap it or describe it', 'Upload a photo of your car, scooter or door, or type “a red pickup truck”. Aholo Lux3D builds a textured 3D model in about two minutes, live inside the app.', img('report/asset-pickup.png', 'Lux3D pickup truck', 'art'))}
  ${card('02 · True scale', 'Put it on your street', 'Type your street, town or postcode, anywhere in the world, or press Use my location. Waterline finds street level in Google’s photorealistic 3D city, and the model stands at its real height on the real ground.', img('report/app-describe.jpg', 'Typed pickup placed on a real street', 'art map'))}
  ${card('03 · Impact', 'Raise the water', 'Play the flood and watch it reach the wheels, the windows, your waist. Then check modelled river-flood depths for that spot and find the walking route to higher ground.', img('report/app-escape.jpg', 'Walking route to higher ground', 'art map'))}
</div>
<p class="foot">Works in two modes: Real street (live 3D city and data) and Studio (an original illustrative street that needs no map account, for instant demos).</p>`)}

${slide('Aholo Lux3D at the core', 'Every object in the flood<br>is made by Lux3D.', `
<div class="flow">
  <div><b>Photo or words</b>Visitor uploads a photo or types a description</div><span>→</span>
  <div class="lux"><b>Aholo Lux3D</b>Image-to-3D or Text-to-3D · G1-Turbo · PBR materials · AI size prediction · 60k-face budget</div><span>→</span>
  <div><b>Measure</b>Waterline reads the GLB’s mesh bounds and node transforms</div><span>→</span>
  <div><b>Real height</b>Your choice → your words (“pickup” = 1.8 m) → Lux3D’s estimate if it is in metres → ask</div><span>→</span>
  <div><b>On your street</b>Base on the real ground of the 3D city; water depth measured per object</div>
</div>
<div class="grid" style="grid-template-columns: 58fr 42fr">
  <div class="panel" style="padding:8px 14px"><table><tr><th></th><th>Library model</th><th>Prompt or source</th></tr>${libraryRows}</table></div>
  <div class="panel small">
    <h2>The subject, not decoration</h2>
    <p>The water is always measured against a Lux3D model. The Library ships ${fromPhoto.length} models made from CC0 photos and ${fromText.length} from text, each with its task ID, prompt or photo credit, and SHA-256 recorded in <code>library.json</code>.</p>
    <h2>Live, inside the app</h2>
    <p>Visitors make their own models in about two minutes. A small Node server keeps the Lux3D API key off the browser: it uploads photos through Aholo’s asset service, creates the task, polls it and downloads the GLB, with per-visitor hourly and daily limits.</p>
    <h2>Sized for the real world</h2>
    <p style="margin:0">Each model is measured from its own mesh and stood on the real ground of the 3D city, so “1.2 m of water” lands exactly where it would on your car.</p>
  </div>
</div>`)}

${slide('Asset iterations · 1', 'What each Lux3D model<br>taught us.', `
<div class="grid g3">
  <div class="card"><div class="pair">${img('report/asset-picnic-table.png', 'First Lux3D test: a picnic table')}${img('report/asset-suv.png', 'Family SUV')}</div>
    <span class="step">14 Nov · first contact</span><h3>Scale is not given, it must be decided</h3>
    <p>The first photo test (a picnic table) came back in estimated metres; the first text model, the Family SUV, came back in a 10-unit box. So every model is scaled to a real height, and the user’s choice always wins.</p></div>
  <div class="card"><div class="pair">${img('report/asset-suv.png', 'Family SUV, about 280,000 triangles')}${img('report/asset-small-car.png', 'Small car with a 60,000-face budget')}</div>
    <span class="step">14 Nov · weight</span><h3>280k → about 60k triangles</h3>
    <p>Lux3D’s default gave the SUV about 280,000 triangles (17 MB), too heavy for a street of objects. With <code>faceCount: 60000</code> every later model lands at 55,000–67,000 triangles with the same silhouette.</p></div>
  <div class="card"><div class="pair">${img('report/front-door-v1-source.jpg', 'CC0 photo of a front door', 'photo')}${img('report/asset-door-v1-back.png', 'Photo-made door, back view')}</div>
    <div class="pair" style="margin-top:6px">${img('report/asset-door-v1.png', 'Photo-made door, front view')}${img('report/asset-door-v2.png', 'Text-made door that replaced it')}</div>
    <span class="step">16 Nov · rejected</span><h3>Door v1 → door v2</h3>
    <p>From a photo, the door became a one-sided slab with a grimy back. Rebuilt from text (“a single closed wooden front door… white frame, stone doorstep”), it is clean from every side.</p></div>
</div>`)}

${slide('Asset iterations · 2', 'Sizing, nonsense<br>and weight.', `
<div class="grid g3">
  <div class="card"><div class="pair">${img('../public/models/sources/small-car.jpg', 'CC0 photo of a die-cast Toyota Yaris', 'photo')}${img('report/asset-small-car.png', 'Lux3D small car')}</div>
    <span class="step">16 Nov · a toy?</span><h3>A car Lux3D sized at 15 cm</h3>
    <p>The CC0 photo was of a die-cast model, and Lux3D’s size prediction correctly called it 15 cm. Good for Lux3D, wrong for a flood. Library models carry a human-checked height (1.5 m).</p></div>
  <div class="card"><div class="pair">${img('report/asset-pickup.png', 'Lux3D result for “a red pickup truck”')}${img('report/asset-camera.png', 'Lux3D result for “asdfghjkl”: a camera')}</div>
    <span class="step">16 Nov · live test</span><h3>“a red pickup truck” and “asdfghjkl”</h3>
    <p>The truck came back in a 12-unit box (it would have stood 4.8 m tall); the nonsense became a 17 cm camera. Hence <b>Auto size</b>: your words first, then Lux3D’s metres when they look real, otherwise ask, plus tappable example ideas.</p></div>
  <div class="card"><p class="big" style="margin:8px 0 2px">${mb(originalTotal)} → ${mb(shippedTotal)} MB</p><p class="muted" style="margin-bottom:8px">all six Library models</p>
    <span class="step">16 Nov · web delivery</span><h3>Same geometry, lighter textures</h3>
    <p>2048 px PNG textures were most of each file. A build step re-encodes them as JPEG without touching the mesh; the original Lux3D downloads and both SHA-256 hashes are kept. Library thumbnails and the homepage hero are rendered from the models themselves.</p></div>
</div>`, 'cream')}

${slide('Real streets, real data', 'Your street. Real<br>flood data.', `
<div class="grid g2">
  <div>${img('report/app-kerrville.jpg', 'Kerrville demo on the real 3D city', 'shot')}<p class="small muted" style="margin-top:6px">Kerrville, Texas: Louise Hays Park on the Guadalupe. The Lux3D SUV is “up to the windows”, the adult chest-deep.</p></div>
  <div>${img('report/app-risk.jpg', 'Modelled river-flood depths', 'shot')}<p class="small muted" style="margin-top:6px">Modelled river-flood depths for the spot, from 10%-a-year to 0.2%-a-year floods. Each can be shown on the street.</p></div>
</div>
<div class="panel small" style="margin-top:12px"><b>Under the hood:</b> CesiumJS with Google Photorealistic 3D Tiles and Google place search (Cesium ion) or the browser’s location · the spot is moved off roofs and treetops to the street automatically · ground height sampled from the 3D city at every object · JRC / Copernicus <i>Global river flood hazard maps</i> v2.1 read directly from cloud GeoTIFFs with HTTP range requests · honest gaps: where the model shows 0 m, the app says that does <b>not</b> mean safe (it omits flash and coastal floods, the kind that struck Kerrville and Valencia).</div>`)}

${slide('A way out', 'Then it shows<br>the way to higher ground.', `
<div class="grid g37">
  <div>
    <p class="lede">Seeing the water is half the job. Waterline then answers “where do I go?”</p>
    <ul>
      <li>Searches the terrain (Cesium World Terrain) ring by ring for the nearest ground at least 1 m above this flood, ignoring roof-sized bumps.</li>
      <li>Gets a real walking route there (OSRM on OpenStreetMap, via FOSSGIS).</li>
      <li>Reports distance, minutes on foot, and how deep the water on the way would be: <i>“the route goes through up to 1.2 m of water, so leave before the water arrives.”</i></li>
      <li>Ends with plain advice: go early; never go back for your car or into underground garages; if cut off, go to the highest floor.</li>
    </ul>
  </div>
  ${img('report/app-escape.jpg', 'Higher ground route in Kerrville', 'shot')}
</div>`)}

${slide('Aholo World · inside your home', 'Then it shows the water<br>coming inside.', `
<div class="flow">
  <div><b>One photo</b>of a room, or a description</div><span>→</span>
  <div class="lux"><b>Aholo World</b>builds the room in 3D as Gaussian splats (SPZ), in about 10 minutes</div><span>→</span>
  <div><b>Scale</b>to the ceiling height you give (a room from one photo has no true size)</div><span>→</span>
  <div><b>Same flood</b>the street’s water, minus how far your floor sits above the street</div>
</div>
<div class="grid" style="grid-template-columns: 40fr 60fr">
  <div class="panel small">
    <p style="margin-top:0">The street shows the water outside. <b>Inside</b> shows it coming in: everything below the waterline turns muddy, and the panel says what that depth means indoors (sockets at about 30 cm, furniture, when to go upstairs).</p>
    <p>An example living room ships with the app; your own room keeps building even if you close the page. Shown with three.js and Spark.</p>
    <p style="margin:0"><b>Iterations:</b> a 2:1 panorama crop failed in 7 s; an ordinary 4:3 photo built a room in about 8 minutes, so the app now always sends an ordinary photo about 1280 px across. The example room: 4.1 MB, about 250,000 splats.</p>
  </div>
  <div class="grid g2" style="gap:10px; align-content:start">
    <figure style="margin:0">${img('report/app-room-dry.jpg', 'Aholo World room before the flood', 'shot')}<figcaption class="small muted">Dry</figcaption></figure>
    <figure style="margin:0">${img('report/app-room.jpg', 'The same room with 0.4 m of water inside', 'shot')}<figcaption class="small muted">0.6 m in the street → 0.4 m inside</figcaption></figure>
  </div>
</div>`)}

${slide('Fun and engagement', 'Play with it,<br>and it plays back.', `
<div class="grid g45">
  <div>
    <div class="panel small">
      <h2>Live impact</h2><p>As the water rises, every object reports what is happening to it: <i>wheels in water → can float → up to the windows</i>; a person goes <i>ankle-deep → waist-deep → over their head</i>, with blue-amber-red bars.</p>
      <h2>Aim the water</h2><p>The water slider carries a marker at the top of each object, so you can drag the flood to “just over the car”.</p>
      <h2>Depth detective</h2><p>Guess the depth that covers an object, then watch the flood play to the answer.</p>
      <h2 style="margin-top:8px">One space per job</h2><p style="margin:0">A homepage, then eight focused spaces (Spot, Things, Water, Risk, Escape, Inside, Guess, Share) with big type, share links, saved scenes, 3D image export and a cinema mode for recording.</p>
    </div>
  </div>
  <div class="grid" style="grid-template-columns: 3fr 1.05fr; gap:14px">${img('report/app-water.jpg', 'Water space with facts and the water dock', 'shot')}${img('report/app-phone.jpg', 'Phone layout', 'shot')}</div>
</div>`)}

${slide('Development process', 'Five days, built<br>and rebuilt by testing.', `
<div class="timeline">
  <div class="day"><b class="date">14 November</b><br><b>Idea → working core.</b> Chose floods over other map ideas. Built the Lux3D client (upload, create, poll, download), the real 3D street with a “bathtub” water level and moving-water facts. Asked “does a picture help anyone?” and added real JRC flood depths and the higher-ground finder.</div>
  <div class="day"><b class="date">15 November</b><br><b>A demo that always works.</b> Studio street needing no map account; Depth detective; move, duplicate, undo; share links, scene files and image export; an automated browser test suite.</div>
  <div class="day"><b class="date">16 November</b><br><b>Lux3D everywhere, then real users.</b> Rebuilt the Library as six Lux3D models; lighter textures. User test: “it doesn’t seem functional”, so the demo now starts itself, framed at street level. Live “Describe” test led to Auto size. The interface was redesigned twice: a homepage and one space per function.</div>
  <div class="day"><b class="date">17 November</b><br><b>Finishing.</b> A “waterline” ring that rises with the water around the homepage car; the homepage appears instantly while the 3D engine loads behind it; the app behind the homepage is keyboard-safe; this report and the captioned demo video, all captured from the running app.</div>
  <div class="day"><b class="date">18 November</b><br><b>Your street, anywhere; then inside.</b> User test: “I can’t put in my location”. Now a search box and Use my location set the spot at street level by themselves (tested in Houston, London, Lagos, Abuja, Buenos Aires, Mendoza). Then Aholo World: the water inside a room.</div>
</div>
<div class="ui3">
  <figure>${img('report/ui-v1.jpg', 'Interface version 1')}<figcaption>v1 · a long sidebar form</figcaption></figure>
  <figure>${img('report/ui-v2.jpg', 'Interface version 2')}<figcaption>v2 · dark, map-first, live impact panel</figcaption></figure>
  <figure>${img('report/app-things.jpg', 'Interface version 3')}<figcaption>v3 · sky and cream, big type, one space per function</figcaption></figure>
</div>`, 'cream')}

${slide('Build and tools', 'How it is built,<br>and with what.', `
<div class="grid g37">
  <div class="panel small">
    <h2>Architecture</h2>
    <p>Browser: CesiumJS 1.145 and plain JavaScript, served locally. Server: a zero-framework Node app that proxies Lux3D (key stays server-side, with quotas), JRC data and routing.</p>
    <h2>Quality</h2>
    <p style="margin:0">37 automated unit tests and five browser checks: the full Studio flow offline, the interface at three screen sizes, the live map, your own street (search, location, live Lux3D models placed) and the Aholo World room. Every screenshot in this report is of the running app; the asset pictures are renders of the actual Lux3D files.</p>
  </div>
  <div class="panel" style="padding:10px 16px"><table>
    <tr><th>Tool</th><th>Used for</th></tr>
    <tr><td><b>Aholo Lux3D API</b></td><td>Image-to-3D and Text-to-3D for every 3D object, including live generation in the app</td></tr>
    <tr><td><b>Aholo World API</b></td><td>3D rooms (Gaussian splats) from a photo or a description, for “Inside your home”</td></tr>
    <tr><td>CesiumJS · Cesium ion</td><td>Google Photorealistic 3D Tiles, Cesium World Terrain, Google place search</td></tr>
    <tr><td>three.js · Spark (MIT)</td><td>Showing Aholo World rooms in the browser</td></tr>
    <tr><td>JRC / Copernicus EMS (CC BY 4.0)</td><td>Global river flood hazard maps v2.1, read with geotiff.js</td></tr>
    <tr><td>FOSSGIS OSRM · OpenStreetMap</td><td>Walking routes to higher ground</td></tr>
    <tr><td>US National Weather Service</td><td>Moving-water safety facts</td></tr>
    <tr><td>Poly Haven (CC0) · CC0 photos</td><td>Studio street textures · source photos for two Lux3D models</td></tr>
    <tr><td>Google model-viewer · Playwright + Microsoft Edge</td><td>Rendering thumbnails · automated tests, screenshots and this PDF</td></tr>
    <tr><td>Cinzel Decorative · Poppins · Allura (OFL)</td><td>Typography</td></tr>
    <tr><td><b>Claude Code (Anthropic)</b>, an AI coding assistant</td><td>Wrote most of the code and tests and drafted this report, under the participant’s direction: concept, design references, decisions and user testing</td></tr>
  </table></div>
</div>`)}

${slide('Limits and next steps', 'Honest about what<br>it is, and is not.', `
<div class="grid g2">
  <div class="panel small"><h2>Limits</h2><ul>
    <li>The water is a flat level from your spot (a “bathtub” model): no flow, walls, drains or timing. It is a planning illustration, not a forecast.</li>
    <li>The JRC model has ~90 m cells and covers river floods only: no flash or coastal floods.</li>
    <li>Google’s 3D city blurs at street level in narrow streets; the camera frames from above the roofs there.</li>
    <li>AI sizes are estimates: the app shows the height it used and lets you correct it. Rooms from one photo are scaled to the ceiling height you give.</li>
    <li>Higher ground is planning help, not an evacuation order. Follow official warnings; never enter floodwater.</li>
  </ul></div>
  <div class="panel small"><h2>Next</h2><ul>
    <li><b>More of Lux3D:</b> retopology for lighter models, multi-format export for AR so you can see the water line in your own driveway.</li>
    <li><b>Aholo World reconstruction:</b> a phone video of your ground floor for a true-scale room, instead of one photo.</li>
    <li><b>SpatialLM:</b> find the doors, sockets and furniture in that room, so the water reads out “over the sofa”.</li>
    <li>Community flood marks: “the water reached here in 2024”.</li>
    <li>Official local warnings beside the illustration.</li>
    <li>More languages, starting with Spanish.</li>
  </ul>
  <p class="script" style="margin-top:22px">see the water before it comes</p></div>
</div>
<div class="strip">${lux.map((e) => `<img src="../public${esc(e.thumbnail ?? '')}" alt="${esc(e.name)}">`).join('')}</div>
<p class="foot">Credits: Aholo Lux3D · CesiumJS (Apache-2.0) · Google Photorealistic 3D Tiles via Cesium ion · JRC / Copernicus EMS (CC BY 4.0) · OSRM / © OpenStreetMap contributors · US NWS · Poly Haven (CC0) · fonts under SIL OFL. Full list in THIRD_PARTY_NOTICES.txt.</p>`)}
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
const hasVideo = await fs.stat(path.join(out, 'waterline-demo.webm')).then((s) => s.size > 0, () => false);
await fs.writeFile(path.join(out, 'submission-checklist.json'), JSON.stringify({
  officialEvent: 'https://www.aholo.ai/hackathon', submissionPortal: 'https://www.aholo.ai/hackathon/my',
  deadlineUtc: '2026-11-19T11:00:00Z', deadlineLagos: '19 November 2026 at 12:00 noon',
  ready: [`Project report PDF (${pageNo} pages)`, 'Lux3D evidence for every Library model', 'Source archive', ...(hasVideo ? ['Demo video (WebM): review before uploading'] : []), ...((await fs.stat(path.join(out, 'waterline-demo.mp4')).then((s) => s.size > 0, () => false)) ? ['Demo video (MP4 copy) for forms that need MP4'] : [])],
  participantActions: ['Confirm registration and team (solo counts) in the official portal.', 'Check the tools list in the report and add any other tool you used.', 'Upload the report and the demo video (or a working hosted link) to My Submission before the deadline.', 'Post on X with #Manycorehackathon and add the link (5% of the expert score; register it for the Popularity Award by 30 Nov).'],
  submission: 'Not submitted by this script.',
}, null, 2));
await fs.writeFile(path.join(out, 'x-post-draft.txt'), [
  'Flood maps show a blue patch. Waterline shows the water at your car’s windows, on your street.',
  '',
  'Snap your car, Aholo Lux3D makes it 3D at true scale, then raise the flood in a real 3D city and find the way to higher ground.',
  '',
  '[attach the demo video, or paste its link] #Manycorehackathon #Lux3D',
].join('\n'));
const tests = (await fs.readdir('test')).filter((name) => name.endsWith('.mjs')).map((name) => `test/${name}`);
const includes = ['package.json', 'package-lock.json', 'server.mjs', 'lib', 'public', 'scripts', ...tests, 'README.md', '.env.example', '.gitignore', 'Dockerfile', '.dockerignore', 'THIRD_PARTY_NOTICES.txt'];
// Relative, forward-slash paths: GNU tar would read "C:\..." as a remote host.
const archived = spawnSync('tar', ['-czf', 'submission/waterline-source.tar.gz', '--exclude=public/models/generated/*.glb', ...includes], { cwd: root, encoding: 'utf8' });
if (archived.status !== 0) throw new Error(`Source archive failed: ${archived.stderr}`);
const listing = spawnSync('tar', ['-tzf', 'submission/waterline-source.tar.gz'], { cwd: root, encoding: 'utf8' }); // relative: GNU tar reads C: as a host
if (listing.status !== 0 || listing.stdout.split(/\r?\n/).some((name) => /(^|\/)\.env$|node_modules|\.waterline|Screenshot_/.test(name))) throw new Error('Archive validation failed.');
console.log(`Prepared a ${pageNo}-page report, Lux3D evidence, checklist, X draft and source archive in submission/. Nothing was submitted or posted.`);
