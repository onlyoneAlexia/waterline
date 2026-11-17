// Waterline front end: CesiumJS globe + Lux3D models + a rising "bathtub" flood level.
import { measureGlb } from './glb-measure.js';
import { createStudio, studioHeight, pickStudioGround, STUDIO } from './studio.js';
import { pickGround } from './ground-pick.js';
import { validateScene } from './scene.js';

const Cesium = window.Cesium;
const $ = (selector) => document.querySelector(selector);
const deg = (r) => Cesium.Math.toDegrees(r);
const rad = (d) => Cesium.Math.toRadians(d);
const round = (value, digits) => Number(value.toFixed(digits));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Service timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}

const WATER_SIDE_M = 2400; // the flood surface is a square this wide, centred on your pin
const GAUGE_TOP_M = 3;
const MAX_DEPTH_M = 3;
const POLL_MS = 6000;
const JOB_TIMEOUT_MS = 16 * 60 * 1000;

const FACTS = [
  { depth: 0.01, text: 'Never walk or drive into floodwater. Turn around, don’t drown.' },
  { depth: 0.15, text: '15 cm of moving water can knock an adult off their feet.' },
  { depth: 0.3, text: '30 cm of moving water can float and carry away most cars.' },
  { depth: 0.6, text: '60 cm of moving water can sweep away SUVs and trucks.' },
  { depth: 1.0, text: 'At 1 m, the water is around an adult’s waist.' },
  { depth: 1.6, text: 'At 1.6 m, most cars are completely under water.' },
];

// Real places hit by deadly floods. Water depths are illustrative and labelled as such.
// `ground` is the street's height (metres above the WGS84 ellipsoid) in Google's 3D tiles,
// measured once so a tree or roof can never become "street level".
const SCENES = [
  {
    id: 'kerrville',
    button: 'Kerrville, Texas · July 2025',
    lon: -99.142402,
    lat: 30.043724,
    ground: 463.07,
    depth: 1.2,
    view: { heading: 45, pitch: -12, range: 20 },
    objects: [{ id: 'family-suv', ahead: 0, right: -3, turn: 90 }, { id: 'adult-person', ahead: 0, right: 1.5, turn: 0 }],
    story: 'River Trail, Louise Hays Park, beside the Guadalupe River. On 4 July 2025 the river at Kerrville rose about '
      + '8 m (26 ft) in 45 minutes, and more than 100 people died in Kerr County. Shown: an illustrative 1.2 m, up to an SUV’s windows.',
  },
  {
    id: 'paiporta',
    button: 'Paiporta, Spain · October 2024',
    lon: -0.418102,
    lat: 39.427992,
    ground: 73.23,
    depth: 1.5,
    // Google's 3D city melts at street level in narrow streets, so look down the street from above the roofs.
    view: { heading: 120, pitch: -38, range: 52 },
    objects: [{ id: 'family-suv', ahead: 6, right: 1.2, turn: 0 }, { id: 'adult-person', ahead: 3, right: -1.6, turn: 0 }],
    story: 'Carrer Constitució, Paiporta, near Valencia. On 29 October 2024 a flash flood swept through the town, and '
      + '230 people died across Spain. Some were trapped going to get their cars out of garages. Shown: an illustrative 1.5 m.',
  },
];

// How tall a new model should stand. "Auto" reads the description first, then Lux3D's own
// size if it looks real. Typical heights in metres.
const KINDS = [
  { label: 'Auto size', height: null, auto: true },
  { label: 'Car', height: 1.5 },
  { label: 'SUV or pickup', height: 1.8 },
  { label: 'Van', height: 2.1 },
  { label: 'Bus', height: 3.2 },
  { label: 'Bicycle', height: 1.1 },
  { label: 'Motorbike', height: 1.2 },
  { label: 'Adult', height: 1.75 },
  { label: 'Child', height: 1.2 },
  { label: 'Front door', height: 2.1 },
  { label: 'Type a height…', height: null },
];

// Typical heights for words people type ("a red pickup truck", "my scooter"), first match wins.
const HEIGHT_HINTS = [
  [/\b(bus|coach)\b/i, 3.2], [/\b(suv|pickup|pick-up|jeep|4x4|land ?cruiser)\b/i, 1.8],
  [/\b(lorry|truck)\b/i, 3], [/\b(van|minibus|camper)\b/i, 2.1], [/\b(car|hatchback|sedan|saloon|taxi)\b/i, 1.5],
  [/\b(motorbike|motorcycle|scooter|moped|okada|keke|tuk-?tuk)\b/i, 1.2], [/\b(bicycle|bike)\b/i, 1.1],
  [/\b(wheelchair)\b/i, 0.95], [/\b(stroller|pram|buggy)\b/i, 1.05],
  [/\b(child|kid|boy|girl|toddler)\b/i, 1.2], [/\b(adult|person|man|woman|grandma|grandpa|me)\b/i, 1.75],
  [/\b(door|doorway|gate)\b/i, 2.1], [/\b(shed)\b/i, 2.2], [/\b(fridge|refrigerator|freezer)\b/i, 1.8],
  [/\b(wheelie bin|bin|trash can|dustbin)\b/i, 1.07], [/\b(generator)\b/i, 0.7], [/\b(sofa|couch)\b/i, 0.85],
  [/\b(table|desk)\b/i, 0.75], [/\b(chair)\b/i, 0.9], [/\b(bed)\b/i, 0.6], [/\b(dog)\b/i, 0.6],
];

/** A typical real height for an object name or description, or null if it names nothing we know. */
function heightFromWords(text) {
  const hit = HEIGHT_HINTS.find(([pattern]) => pattern.test(String(text ?? '')));
  return hit ? hit[1] : null;
}

// Lux3D usually returns estimated real metres, but sometimes a normalised box about 10–12 units
// long (a pickup came back 12 "metres" long and 4.8 tall). Only trust sizes that don't look like that box.
function looksMetric(bounds) {
  const longest = Math.max(...bounds.size);
  return !(longest >= 9 && longest <= 13) && bounds.size[1] >= 0.03 && bounds.size[1] <= 15;
}

// Chance of a flood at least this big in any given year, for each JRC return period.
const YEARLY_CHANCE = { 10: '10%', 20: '5%', 50: '2%', 100: '1%', 200: '0.5%', 500: '0.2%' };

const SAFETY_MARGIN_M = 1; // "higher ground" must sit at least this far above the water
const SEARCH_RADIUS_M = 3000;
const RING_STEP_M = 40;
const WALK_SPEED_MPS = 1.2;
const SAFE_GREEN = '#4cd964';

const ADVICE = [
  'Go early. In Kerrville, Texas (July 2025) the Guadalupe River rose about 8 m (26 ft) in 45 minutes.',
  'Don’t go back for your car, and never go into basements or underground garages. In Valencia (2024) people were trapped going to get their cars.',
  'If you are cut off, go to the highest floor (not a closed attic) and call emergency services.',
  'Heights and routes are estimates from open data. Always follow official warnings.',
];

const JOB_LABELS = {
  uploading: 'Sending to Lux3D…',
  queued: 'Waiting in the Lux3D queue…',
  running: 'Lux3D is building your 3D model…',
  reconnecting: 'Connection hiccup. Lux3D keeps building; still checking…',
  done: 'Ready! Click the map to place it.',
};

const state = {
  mode: 'studio',
  viewer: null,
  water: null,
  pin: null, // { lon, lat, height } in radians / metres
  gauge: [],
  depth: 0,
  objects: [],
  selected: null,
  pending: null, // a measured model waiting to be placed with a click
  library: [],
  myModels: [],
  jobs: [],
  generationEnabled: false,
  orbitOff: null,
  playRaf: 0,
  playResolve: null,
  nextId: 1,
  history: [],
  moving: null,
  depthSource: 'Manual illustration - not a forecast',
  terrainPromise: null, // bare-earth terrain used for the higher-ground search
  safety: null, // { depth } of the last search, so a new water level can invalidate it
  safetyEntities: [],
  safetySearch: 0, // increments to cancel an older search
};

// ---------- small helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer = 0;
function toast(message, ms = 4500) {
  const box = $('#toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, ms);
}

function showSetupError(message) {
  $('#map').append(el('div', 'setup-error', message));
}

function encodeBase64Url(text) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '==='.slice((base64.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

const allFinite = (...values) => values.every((v) => Number.isFinite(v));

// ---------- map setup ----------

async function loadWorld(viewer) {
  try {
    // Camera collision is off: over Paiporta a tile with a bad height shoved the camera up to ~6 km.
    const tiles = await within(Cesium.createGooglePhotorealistic3DTileset(
      { onlyUsingWithGoogleGeocoder: true },
      { enableCollision: false },
    ), 12_000);
    viewer.scene.primitives.add(tiles);
    viewer.scene.globe.show = false;
    state.worldKind = 'photorealistic';
  } catch (error) {
    state.worldKind = 'terrain';
    console.warn('Google Photorealistic 3D Tiles unavailable; falling back to terrain + OSM buildings.', error);
    toast('Photorealistic 3D city unavailable, so showing terrain and simple buildings instead.', 7000);
    const imagery = Cesium.ImageryLayer.fromWorldImagery();
    imagery.errorEvent.addEventListener((imageryError) => console.warn('World imagery unavailable.', imageryError));
    viewer.imageryLayers.add(imagery);
    const terrain = Cesium.Terrain.fromWorldTerrain();
    terrain.errorEvent.addEventListener((terrainError) => console.warn('World terrain unavailable.', terrainError));
    viewer.scene.setTerrain(terrain);
    viewer.scene.globe.depthTestAgainstTerrain = true;
    try {
      viewer.scene.primitives.add(await within(Cesium.createOsmBuildingsAsync(), 8000));
    } catch (buildingError) {
      console.warn('OSM Buildings unavailable.', buildingError);
    }
  }
}

// The flood surface: one flat square kept in local east-north-up coordinates,
// so raising the water only changes the primitive's modelMatrix (needs scene3DOnly).
function createWater(viewer) {
  const half = WATER_SIDE_M / 2;
  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: new Float64Array([-half, -half, 0, half, -half, 0, half, half, 0, -half, half, 0]),
      }),
      normal: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
        values: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      }),
      st: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      }),
    },
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: new Cesium.BoundingSphere(new Cesium.Cartesian3(0, 0, 0), half * Math.SQRT2),
  });

  // Muddy, gently moving water. Based on Cesium's Water material, but the plane's
  // own frame is its tangent frame, so the normal only needs czm_normal.
  const material = new Cesium.Material({
    translucent: true,
    fabric: {
      type: 'FloodWater',
      uniforms: {
        normalMap: Cesium.buildModuleUrl('Assets/Textures/waterNormals.jpg'),
        baseColor: new Cesium.Color(0.19, 0.25, 0.23, 0.94),
        frequency: WATER_SIDE_M * .8,
        elapsedSeconds: 0,
        amplitude: 1.25,
        specularIntensity: 0.8,
      },
      source: `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material m = czm_getDefaultMaterial(materialInput);
  float time = elapsedSeconds * 0.06;
  vec4 noise = czm_getWaterNoise(normalMap, materialInput.st * frequency, time, 0.0);
  vec3 n = normalize(noise.xyz * vec3(1.0, 1.0, 1.0 / amplitude));
  m.normal = normalize(czm_normal * n);
  float facing = clamp(dot(normalize(materialInput.positionToEyeEC), m.normal), 0.0, 1.0);
  float fresnel = pow(1.0 - facing, 4.0);
  m.diffuse = mix(baseColor.rgb, vec3(0.42, 0.51, 0.54), fresnel * 0.65) + 0.025 * n.z;
  m.emission = vec3(0.12, 0.17, 0.19) * fresnel * 0.12;
  // Fade out towards the edges (from ~650 m), so the square never shows from above and the
  // flat "bathtub" level reads as a local illustration rather than a city-wide prediction.
  float fromCentre = length(materialInput.st - 0.5) * 2.0;
  m.alpha = baseColor.a * (1.0 - smoothstep(0.55, 0.98, fromCentre));
  m.specular = specularIntensity;
  m.shininess = 64.0;
  return m;
}`,
    },
  });

  const primitive = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({ geometry }),
    appearance: new Cesium.MaterialAppearance({
      material,
      materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
      translucent: true,
      faceForward: true,
    }),
    asynchronous: false,
    allowPicking: false,
    show: false,
  });
  viewer.scene.primitives.add(primitive);
  const waterStarted = performance.now();
  viewer.scene.preRender.addEventListener(() => { material.uniforms.elapsedSeconds = (performance.now() - waterStarted) / 1000; });
  return primitive;
}

function updateWater() {
  if (!state.water) return;
  if (!state.pin || state.depth < 0.005) {
    state.water.show = false;
    return;
  }
  const { lon, lat, height } = state.pin;
  state.water.modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromRadians(lon, lat, height + state.depth),
  );
  state.water.show = true;
}

// Light the scene as if it were early afternoon where the pin is.
function setLocalMidday(lonRad) {
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const utcHours = ((((state.mode === 'studio' ? 15.5 : 13) - deg(lonRad) / 15) % 24) + 24) % 24;
  state.viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(utcMidnight + utcHours * 3_600_000));
  state.viewer.clock.shouldAnimate = false;
}

// ---------- pin + depth gauge ----------

function drawGauge() {
  const { viewer } = state;
  state.gauge.forEach((entity) => viewer.entities.remove(entity));
  state.gauge = [];
  const { lon, lat, height } = state.pin;
  const at = (metres) => Cesium.Cartesian3.fromRadians(lon, lat, height + metres);
  const labelStyle = {
    font: '600 13px system-ui, sans-serif',
    fillColor: Cesium.Color.WHITE,
    outlineColor: Cesium.Color.BLACK,
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
    pixelOffset: new Cesium.Cartesian2(10, 0),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  };

  state.gauge.push(viewer.entities.add({
    polyline: { positions: [at(0), at(GAUGE_TOP_M)], width: 3, material: Cesium.Color.WHITE.withAlpha(0.9) },
  }));
  for (let m = 0.5; m <= GAUGE_TOP_M + 1e-6; m += 0.5) {
    const whole = Number.isInteger(m);
    state.gauge.push(viewer.entities.add({
      position: at(m),
      point: { pixelSize: whole ? 8 : 5, color: Cesium.Color.WHITE, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: whole ? { ...labelStyle, text: `${m} m` } : undefined,
    }));
  }
  state.gauge.push(viewer.entities.add({
    position: at(0),
    point: { pixelSize: 12, color: Cesium.Color.fromCssColorString('#3fa7ff'), outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
  }));
  state.gauge.push(viewer.entities.add({
    position: new Cesium.CallbackPositionProperty(() => at(state.depth), false),
    label: {
      ...labelStyle,
      text: new Cesium.CallbackProperty(() => `Water ${state.depth.toFixed(2)} m`, false),
      fillColor: Cesium.Color.fromCssColorString('#ffcf5c'),
      font: '700 15px system-ui, sans-serif',
      horizontalOrigin: Cesium.HorizontalOrigin.RIGHT,
      pixelOffset: new Cesium.Cartesian2(-14, 0),
    },
    show: new Cesium.CallbackProperty(() => state.depth >= 0.005, false),
  }));
}

function setPin(carto) {
  state.pin = { lon: carto.longitude, lat: carto.latitude, height: carto.height };
  for (const id of ['play', 'safe-go', 'orbit']) $(`#${id}`).disabled = false;
  $('#map-guidance').textContent = 'Your spot is set. Adjust the water to explore.';
  drawGauge();
  setLocalMidday(carto.longitude);
  updateWater();
  renderImpact();
  clearSafety();
  loadRisk();
  $('#pin-status').textContent = 'Your spot is set. Click somewhere else on the street to move it.';
}

// ---------- real flood data: JRC / Copernicus global river flood model ----------

async function loadRisk() {
  const pin = state.pin;
  const box = $('#risk');
  box.hidden = false;
  if (state.mode === 'studio') {
    box.replaceChildren(el('p', 'hint', 'Studio uses illustrative terrain, not flood-hazard data. Switch to Real street mode for the JRC river model.'));
    return;
  }
  box.replaceChildren(el('p', 'hint', 'Checking the global river flood model for this spot…'));
  try {
    const response = await fetch(`/api/flood-depth?lat=${deg(pin.lat).toFixed(6)}&lon=${deg(pin.lon).toFixed(6)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (state.pin === pin) renderRisk(data);
  } catch (error) {
    if (state.pin === pin) {
      const retry = el('button', '', 'Retry flood lookup'); retry.onclick = loadRisk;
      box.replaceChildren(el('p', 'hint', 'Flood model unavailable. You can still set the water by hand.'), retry);
    }
  }
}

function renderRisk(data) {
  const rows = Object.entries(data.depths ?? {})
    .map(([rp, cell]) => ({ rp: Number(rp), here: Number(cell.here) || 0, nearby: Number(cell.nearby) || 0 }))
    .sort((a, b) => a.rp - b.rp);
  const flooded = rows.filter((r) => r.nearby > 0);
  const parts = [el('p', 'risk-title', 'Modelled river flooding - ~90 m cells')];
  if (data.covered === false) {
    $('#risk').replaceChildren(...parts, el('p', 'warning', 'No dataset coverage here. Flood risk is unknown; this is not a zero-depth result.'));
    return;
  }

  if (!flooded.length) {
    parts.push(el('p', 'warning',
      'The model shows no river flooding here, even for a 1-in-500-year flood. That does not mean you are safe: '
      + 'it leaves out flash floods from heavy rain, small streams and the sea. Those are the floods that killed people '
      + 'in Kerrville, Texas (2025) and Valencia, Spain (2024). At the flooded spots we checked there, this model shows no flooding either.'));
  } else {
    const list = el('ul');
    for (const row of flooded) {
      const label = row.here > 0
        ? `${YEARLY_CHANCE[row.rp]}-a-year flood: ${row.here.toFixed(1)} m here`
        : `${YEARLY_CHANCE[row.rp]}-a-year flood: up to ${row.nearby.toFixed(1)} m within 200 m`;
      const show = el('button', '', 'Show');
      show.addEventListener('click', () => {
        stopPlaying();
        setDepth(row.here > 0 ? row.here : row.nearby, `JRC river model - ${YEARLY_CHANCE[row.rp]} annual chance - ${row.here > 0 ? 'cell at pin' : 'nearby maximum, not depth at pin'}`);
      });
      const li = el('li');
      li.append(el('span', '', label), show);
      list.append(li);
    }
    parts.push(list);
    parts.push(el('p', 'hint', '“10%-a-year” means a flood at least this deep has a 1 in 10 chance of happening in any year. '
      + 'Rough model with ~90 m cells: a guide, not an exact street depth. It leaves out flash floods and the sea.'));
    if (flooded.some((r) => r.nearby > 10)) parts.push(el('p', 'warning', 'Very deep values can be errors in the model near river channels.'));
  }
  parts.push(el('p', 'attribution', data.attribution ?? ''));
  $('#risk').replaceChildren(...parts);
}

// ---------- get to higher ground ----------

function clearSafety(message) {
  state.safetySearch += 1;
  state.safety = null;
  state.safetyEntities.forEach((entity) => state.viewer.entities.remove(entity));
  state.safetyEntities = [];
  const box = $('#safety');
  box.hidden = !message;
  box.replaceChildren(...(message ? [el('p', 'hint', message)] : []));
}

function terrainProvider() {
  state.terrainPromise ??= Cesium.createWorldTerrainAsync().catch((error) => {
    state.terrainPromise = null;
    throw error;
  });
  return state.terrainPromise;
}

// Bare-earth heights (Cesium World Terrain), so roofs and trees never count as "higher ground".
// Tests can swap in a synthetic sampler through the ?debug hook.
let heightSampler = null;
async function sampleHeights(cartographics) {
  if (heightSampler) return heightSampler(cartographics);
  if (state.mode === 'studio') {
    cartographics.forEach((p) => { p.height = studioHeight(p.longitude, p.latitude); });
    return cartographics;
  }
  return Cesium.sampleTerrainMostDetailed(await terrainProvider(), cartographics);
}

function offsetCarto(lon, lat, eastM, northM) {
  const R = 6_378_137;
  return Cesium.Cartographic.fromRadians(lon + eastM / (R * Math.cos(lat)), lat + northM / R);
}

/** Half the horizontal diagonal of a model at its real size, in metres. */
function footprintRadius(item) {
  const size = item.bounds?.size;
  if (!size) return 2.5;
  const scale = item.realHeight / Math.max(size[1], 1e-6);
  return Math.hypot(size[0] * scale, size[2] * scale) / 2;
}

/** The nearest spot beside the pin where `template` won't overlap anything already placed. */
function clearSpotNearPin(template) {
  const R = 6_378_137;
  const { lon, lat } = state.pin;
  const radius = footprintRadius(template);
  const candidates = [[-4, 0], [4, 0], [0, -4], [0, 4], [-4, -4], [4, 4], [-4, 4], [4, -4], [-8, 0], [8, 0], [0, -8], [0, 8]];
  const fits = ([east, north]) => state.objects.every((o) => {
    const dx = (o.lon - lon) * R * Math.cos(lat) - east;
    const dy = (o.lat - lat) * R - north;
    return Math.hypot(dx, dy) >= footprintRadius(o) + radius + 0.6;
  });
  const [east, north] = candidates.find(fits) ?? candidates[0];
  return offsetCarto(lon, lat, east, north);
}

const SOLID_GROUND_RADIUS_M = 20;

/**
 * Nearest point at least `target` metres high, searching outwards ring by ring.
 * In towns the terrain model can carry building-sized bumps, so a candidate only counts
 * if four points 20 m around it are high too (a min-filter: a hill passes, a roof doesn't).
 */
async function searchHigherGround(pin, target, searchId) {
  const ringsPerBatch = 10;
  for (let first = RING_STEP_M; first <= SEARCH_RADIUS_M; first += RING_STEP_M * ringsPerBatch) {
    const batch = [];
    for (let r = first; r < first + RING_STEP_M * ringsPerBatch && r <= SEARCH_RADIUS_M; r += RING_STEP_M) {
      const n = Math.max(16, Math.min(72, Math.round((2 * Math.PI * r) / RING_STEP_M)));
      for (let k = 0; k < n; k++) {
        const angle = (2 * Math.PI * k) / n;
        const point = offsetCarto(pin.lon, pin.lat, r * Math.sin(angle), r * Math.cos(angle));
        point.ring = r;
        batch.push(point);
      }
    }
    await sampleHeights(batch);
    if (searchId !== state.safetySearch) return undefined;
    const candidates = batch.filter((p) => Number.isFinite(p.height) && p.height >= target);
    if (candidates.length) {
      const d = SOLID_GROUND_RADIUS_M;
      const around = candidates.flatMap((p) => [[d, 0], [-d, 0], [0, d], [0, -d]].map(([e, n]) => {
        const q = offsetCarto(p.longitude, p.latitude, e, n);
        q.owner = p;
        return q;
      }));
      await sampleHeights(around);
      if (searchId !== state.safetySearch) return undefined;
      for (const q of around) {
        q.owner.solid = Math.min(q.owner.solid ?? q.owner.height, Number.isFinite(q.height) ? q.height : -Infinity);
      }
      const solid = candidates.filter((p) => p.solid >= target);
      if (solid.length) {
        const nearestRing = Math.min(...solid.map((p) => p.ring));
        return solid.filter((p) => p.ring === nearestRing).sort((a, b) => b.solid - a.solid)[0];
      }
    }
    $('#safety').replaceChildren(el('p', 'hint', `Searching for higher ground… checked up to ${(Math.min(first + RING_STEP_M * ringsPerBatch, SEARCH_RADIUS_M) / 1000).toFixed(1)} km`));
  }
  return null;
}

async function fetchRoute(pin, goal) {
  if (state.mode === 'studio') return null;
  try {
    const from = `${deg(pin.lon).toFixed(6)},${deg(pin.lat).toFixed(6)}`;
    const to = `${deg(goal.longitude).toFixed(6)},${deg(goal.latitude).toFixed(6)}`;
    const response = await fetch(`/api/route?from=${from}&to=${to}`);
    if (!response.ok) return null;
    const route = await response.json();
    return Array.isArray(route.coordinates) && route.coordinates.length > 1 ? route : null;
  } catch {
    return null;
  }
}

function everyNth(items, max) {
  if (items.length <= max) return items;
  const step = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)]).concat([items[items.length - 1]]);
}

// A straight line needs intermediate points so its heights can follow the ground.
function densify(coords, pieces) {
  if (coords.length !== 2) return coords;
  const [[x0, y0], [x1, y1]] = coords;
  return Array.from({ length: pieces + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / pieces, y0 + ((y1 - y0) * i) / pieces]);
}

// The route floats 1 m above the ground or the water, whichever is higher, so it stays
// visible over the flood; where buildings hide it, it shows through faintly.
function drawSafety(path, goal, routed, waterLevel) {
  const { viewer } = state;
  const green = Cesium.Color.fromCssColorString(SAFE_GREEN);
  const positions = path.map((p) => Cesium.Cartesian3.fromRadians(
    p.longitude,
    p.latitude,
    Math.max(Number.isFinite(p.height) ? p.height : waterLevel, waterLevel) + 1,
  ));
  state.safetyEntities.push(viewer.entities.add({
    polyline: {
      positions,
      arcType: Cesium.ArcType.NONE,
      width: 8,
      material: routed
        ? new Cesium.PolylineOutlineMaterialProperty({ color: green, outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 2 })
        : new Cesium.PolylineDashMaterialProperty({ color: green }),
      depthFailMaterial: new Cesium.ColorMaterialProperty(green.withAlpha(0.45)),
    },
  }));
  state.safetyEntities.push(viewer.entities.add({
    position: Cesium.Cartesian3.fromRadians(goal.longitude, goal.latitude, goal.height),
    point: {
      pixelSize: 14,
      color: green,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 3,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: 'Higher ground',
      font: '700 15px system-ui, sans-serif',
      fillColor: green,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -14),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  }));
  if (state.orbitOff) toggleOrbit();
  markView(null);
  const sphere = Cesium.BoundingSphere.fromPoints(positions);
  viewer.camera.flyToBoundingSphere(sphere, {
    offset: new Cesium.HeadingPitchRange(viewer.camera.heading, rad(-50), Math.max(300, sphere.radius * 3)),
  });
}

async function findHigherGround() {
  if (!state.pin) return toast('Choose your spot on the map first.');
  if (state.depth < 0.05) return toast('Raise the water first, or pick a flood from the river model.');
  clearSafety('Searching the terrain around you for higher ground…');
  const searchId = state.safetySearch;
  const pin = state.pin;
  const depth = state.depth;
  state.safety = { depth };
  const button = $('#safe-go');
  button.disabled = true;
  try {
    // Compare like with like: the flood level and the candidates both come from the terrain model.
    // (In some towns the terrain model sits metres above the 3D city's streets, so mixing the two
    // sources would invent dry ground.)
    const [start] = await sampleHeights([Cesium.Cartographic.fromRadians(pin.lon, pin.lat)]);
    if (!Number.isFinite(start?.height)) throw new Error('no terrain data here');
    const waterLevel = start.height + depth;
    const goal = await searchHigherGround(pin, waterLevel + SAFETY_MARGIN_M, searchId);
    if (searchId !== state.safetySearch || goal === undefined) return;
    state.safety = { depth };

    const box = $('#safety');
    if (!goal) {
      box.replaceChildren(
        el('p', 'safety-title', 'No higher ground within 3 km'),
        el('p', '', 'Plan to go up instead: the upper floors of a strong, tall building. Leave early if officials tell you to evacuate.'),
        adviceList(),
      );
      return;
    }

    const route = await fetchRoute(pin, goal);
    if (searchId !== state.safetySearch) return;
    const coords = route?.coordinates ?? densify([[deg(pin.lon), deg(pin.lat)], [deg(goal.longitude), deg(goal.latitude)]], 60);

    // Ground heights along the way: to draw the route and to see how deep the water is on it.
    const along = everyNth(coords, 300).map(([x, y]) => Cesium.Cartographic.fromDegrees(x, y));
    await sampleHeights(along);
    if (searchId !== state.safetySearch) return;
    drawSafety(along, goal, Boolean(route), waterLevel);
    const completeHeights = along.length > 0 && along.every((p) => Number.isFinite(p.height));
    const worst = Math.max(0, ...along.filter((p) => Number.isFinite(p.height)).map((p) => waterLevel - p.height));

    const straight = new Cesium.EllipsoidGeodesic(Cesium.Cartographic.fromRadians(pin.lon, pin.lat), goal).surfaceDistance;
    const metres = route?.distance ?? straight;
    const minutes = Math.max(1, Math.round((route?.duration ?? metres / WALK_SPEED_MPS) / 60));
    const distance = metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 10) * 10} m`;

    const parts = [
      el('p', 'safety-title', `${state.mode === 'studio' ? 'Studio example' : 'Higher ground'}: ${distance}, about ${minutes} min on foot`),
      el('p', '', `The ground there stays at least ${((goal.solid ?? goal.height) - waterLevel).toFixed(1)} m above this flood level.`),
    ];
    if (!completeHeights) {
      parts.push(el('p', 'warning', 'Terrain data is missing along this route. Its flood depth is unknown; do not assume it stays dry.'));
    } else if (worst < 0.05) {
      parts.push(el('p', '', 'At this water level the route stays dry.'));
    } else {
      parts.push(el('p', 'warning', `At this water level the route goes through up to ${worst.toFixed(1)} m of water, so leave before the water arrives.`
        + (worst >= 0.15 ? ' Just 15 cm of moving water can knock you over.' : '')));
    }
    if (!route) parts.push(el('p', 'hint', state.mode === 'studio'
      ? 'Synthetic terrain and a straight-line example, not a real walking route. Switch to Real street mode for terrain and routing data.'
      : 'No walking route was found, so this is a straight line. Follow real streets.'));
    parts.push(adviceList());
    box.replaceChildren(...parts);
  } catch (error) {
    if (searchId === state.safetySearch) $('#safety').replaceChildren(el('p', 'hint', `Couldn’t search the terrain (${error.message}).`));
  } finally {
    button.disabled = false;
  }
}

function adviceList() {
  const list = el('ul', 'advice');
  list.append(...ADVICE.map((text) => el('li', '', text)));
  return list;
}

// ---------- 3D objects ----------

const boundsCache = new Map();

async function loadTemplate(entry) {
  if (!boundsCache.has(entry.url)) {
    boundsCache.set(entry.url, (async () => {
      const response = await fetch(entry.url);
      if (!response.ok) throw new Error(`Could not load “${entry.name}” (HTTP ${response.status}).`);
      return measureGlb(await response.arrayBuffer());
    })());
  }
  let bounds;
  try {
    bounds = await boundsCache.get(entry.url);
  } catch (error) {
    boundsCache.delete(entry.url);
    throw error;
  }
  // The height the user chose wins; then a typical height for the words they typed; then
  // Lux3D's own estimate when it looks like real metres. Otherwise 1.5 m, flagged as a guess.
  const fromWords = heightFromWords(entry.name);
  const realHeight = Number(entry.realHeight) > 0 ? Number(entry.realHeight)
    : fromWords ?? (looksMetric(bounds) ? round(bounds.size[1], 2) : 1.5);
  const sizeGuessed = !(Number(entry.realHeight) > 0) && fromWords == null && !looksMetric(bounds);
  const known = [...state.library, ...state.myModels].find((item) => item.url === entry.url);
  return { name: entry.name, url: entry.url, bounds, realHeight, sizeGuessed, source: known?.source, taskId: known?.taskId };
}

function applyObject(obj) {
  const scale = obj.realHeight / Math.max(obj.bounds.size[1], 1e-6);
  // glTF is Y-up; Cesium turns +Y into local up, so lift the model until its lowest point touches the ground.
  const position = Cesium.Cartesian3.fromRadians(obj.lon, obj.lat, obj.ground - obj.bounds.min[1] * scale);
  obj.entity.position = position;
  obj.entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(
    position,
    new Cesium.HeadingPitchRoll(rad(obj.heading), 0, 0),
  );
  obj.entity.model.scale = scale;
  renderImpact();
}

function placeObject(template, carto, extra = {}) {
  rememberObjects();
  const obj = {
    id: state.nextId++,
    name: template.name,
    url: template.url,
    source: template.source,
    taskId: template.taskId,
    bounds: template.bounds,
    lon: carto.longitude,
    lat: carto.latitude,
    ground: carto.height,
    realHeight: extra.realHeight ?? template.realHeight,
    heading: extra.heading ?? 0,
    entity: null,
  };
  obj.entity = state.viewer.entities.add({
    name: obj.name,
    model: { uri: obj.url, minimumPixelSize: 0 },
  });
  applyObject(obj);
  state.objects.push(obj);
  renderObjectList();
  return obj;
}

function removeObject(obj) {
  rememberObjects();
  state.viewer.entities.remove(obj.entity);
  state.objects = state.objects.filter((o) => o !== obj);
  if (state.selected === obj) state.selected = null;
  renderObjectList();
}

function rememberObjects() {
  state.history.push(state.objects.map(({entity, ...object}) => ({...object})));
  if (state.history.length > 30) state.history.shift();
  $('#undo').disabled = false;
}
function undoObjects() {
  const previous = state.history.pop();
  if (!previous) return;
  state.objects.forEach(o => state.viewer.entities.remove(o.entity));
  state.objects = previous.map(o => {
    o.entity = state.viewer.entities.add({ name: o.name, model: { uri: o.url, minimumPixelSize: 0 } });
    applyObject(o); return o;
  });
  state.selected = null; setPending(null);
  $('#undo').disabled = !state.history.length;
  renderObjectList();
}
function selectObject(obj) {
  state.selected = obj;
  renderObjectList();
  document.querySelector(`#object-list li[data-id="${obj.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderObjectList() {
  renderImpact();
  $('#object-list').replaceChildren(...state.objects.map((obj) => {
    const li = el('li', state.selected === obj ? 'selected' : '');
    li.dataset.id = String(obj.id);

    const remove = el('button', '', 'Remove');
    remove.addEventListener('click', () => removeObject(obj));

    const height = el('input');
    Object.assign(height, { type: 'number', min: '0.1', max: '30', step: '0.1', value: String(obj.realHeight) });
    height.setAttribute('aria-label', `Real height of ${obj.name} in metres`);
    height.addEventListener('focus', rememberObjects);
    height.addEventListener('input', () => {
      const value = Number(height.value);
      if (value >= 0.05 && value <= 50) {
        obj.realHeight = value;
        applyObject(obj);
      }
    });

    const turn = el('input');
    Object.assign(turn, { type: 'range', min: '0', max: '359', step: '1', value: String(obj.heading) });
    turn.setAttribute('aria-label', `Direction of ${obj.name}`);
    turn.addEventListener('pointerdown', rememberObjects);
    turn.addEventListener('keydown', event => { if (event.key.startsWith('Arrow')) rememberObjects(); });
    turn.addEventListener('input', () => {
      obj.heading = Number(turn.value);
      applyObject(obj);
    });

    const controls = el('div', 'controls');
    controls.append(el('span', '', 'Height m'), height, el('span', '', 'Turn'), turn);
    const actions = el('div', 'row object-actions');
    const move = el('button', '', 'Move');
    move.onclick = () => { setPending(null); state.moving = obj; $('#place-note').hidden = false; $('#place-note').textContent = 'Click the map to move ' + obj.name + '. Esc to cancel.'; };
    const duplicate = el('button', '', 'Duplicate');
    duplicate.onclick = () => setPending({...obj});
    actions.append(move, duplicate);
    const title = el('span', 'object-title');
    title.append(el('span', 'name', obj.name), el('small', 'library-meta', obj.source?.startsWith('lux3d') ? `Aholo Lux3D · task ${obj.taskId}` : obj.source === 'schematic' ? 'Schematic comparison' : '3D object'));
    li.append(title, remove, controls, actions);
    return li;
  }));
}

function setPending(template) {
  state.pending = template;
  state.moving = null;
  const note = $('#place-note');
  note.hidden = !template;
  note.textContent = template ? `Click the map to place “${template.name}”. (Esc to cancel)` : '';
  $('#map').classList.toggle('placing', !!template);
  $('#map-placement').hidden = !template;
  $('#map-placement').textContent = template ? `Click the street to place ${template.name} · Esc to cancel` : '';
  if (template) toast(`Now click your street to place “${template.name}”.`);
}

// ---------- library + generation ----------

async function loadLibrary() {
  try {
    const response = await fetch('/models/library.json', { cache: 'no-cache' });
    const entries = response.ok ? await response.json() : [];
    if (!response.ok) throw new Error('Library unavailable');
    state.library = Array.isArray(entries) ? entries.filter((e) => typeof e?.url === 'string' && e.url.startsWith('/models/')) : [];
  } catch {
    state.library = [];
  }
  renderLibrary();
  renderChallengeOptions();
}

// Depth detective offers every Library object with a known height, smallest first.
function renderChallengeOptions() {
  const select = $('#challenge-object');
  const previous = select.value;
  const entries = state.library.filter((e) => e.realHeight > 0).sort((a, b) => a.realHeight - b.realHeight);
  if (!entries.length) return;
  select.replaceChildren(...entries.map((e) => {
    const option = el('option', '', e.name);
    option.value = e.id;
    return option;
  }));
  select.value = entries.some((e) => e.id === previous) ? previous : (entries.find((e) => e.id === 'small-car') ?? entries[0]).id;
}

function renderLibrary() {
  const box = $('#library-list');
  const items = [...state.myModels, ...state.library];
  if (!items.length) {
    const retry = el('button', '', 'Reload library'); retry.onclick = loadLibrary;
    box.replaceChildren(el('p', 'hint', 'Library unavailable or empty. Retry, or make a model from a photo or description.'), retry);
    return;
  }
  box.replaceChildren(...items.map((entry) => {
    const button = el('button', 'library-item');
    // A rendered 3D thumbnail of the Lux3D model; photo-made models also show the photo
    // Lux3D started from, so the "photo → 3D" step is visible.
    const thumb = el('span', 'library-thumb');
    if (typeof entry.thumbnail === 'string' && /^\/models\/thumbs\/[\w.-]+$/.test(entry.thumbnail)) {
      const img = el('img', 'model');
      img.src = entry.thumbnail; img.alt = ''; img.loading = 'lazy';
      thumb.append(img);
    } else {
      thumb.append(el('span', 'ico ico-cube library-placeholder'));
    }
    const photo = entry.generation?.sourceImage?.url;
    if (typeof photo === 'string' && /^\/models\/sources\/[\w.-]+$/.test(photo)) {
      const img = el('img', 'library-photo');
      img.src = photo; img.alt = ''; img.loading = 'lazy'; img.title = 'Made from this photo';
      thumb.append(img);
    }
    button.append(thumb);
    const text = el('span', 'library-text');
    text.append(el('strong', '', entry.name));
    const how = { 'lux3d-image-to-3d': 'Lux3D · from a photo', 'lux3d-text-to-3d': 'Lux3D · from text' }[entry.source]
      ?? (entry.source?.startsWith('lux3d') ? 'Aholo Lux3D' : entry.source === 'schematic' ? 'Schematic' : '3D model');
    const details = [entry.realHeight ? `${entry.realHeight} m tall` : 'Adjustable height', how];
    text.append(el('span', 'library-meta', details.join(' · ')));
    button.append(text);
    button.addEventListener('click', async () => {
      const content = [...button.childNodes];
      try {
        button.disabled = true;
        button.replaceChildren(el('span', 'loading', 'Loading model…'));
        setPending(await loadTemplate(entry));
      } catch (error) {
        toast(error.message);
      } finally { button.disabled = false; button.replaceChildren(...content); }
    });
    return button;
  }));
}

function renderJobs() {
  try {
    localStorage.setItem('waterline-jobs', JSON.stringify(state.jobs.filter(job => job.taskId && job.state !== 'done').slice(-10).map(({ name, taskId, realHeight, source }) => ({ name, taskId, realHeight, source }))));
  } catch { /* Storage may be disabled or full. */ }
  $('#jobs').replaceChildren(...state.jobs.map((job) => {
    const row = el('div', `job ${job.state === 'failed' ? 'failed' : ''}`);
    const elapsed = Math.floor((Date.now() - job.started) / 1000);
    const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
    if (job.state !== 'failed' && job.state !== 'done') row.append(el('span', 'spinner'));
    const label = job.state === 'failed' ? `Failed: ${job.error}` : JOB_LABELS[job.state] ?? 'Working…';
    row.setAttribute('role', 'status');
    row.append(el('span', '', `${job.name}: ${label}${job.state === 'done' || job.state === 'failed' ? '' : ` (${clock})`}`));
    if (job.state === 'failed' && job.taskId) {
      const retry = el('button', '', 'Resume status check');
      retry.onclick = async () => { job.state = 'queued'; job.started = Date.now(); renderJobs(); try { await pollJob(job); } catch(error) { job.state = 'failed'; job.error = error.message; renderJobs(); } };
      row.append(retry);
    }
    return row;
  }));
}

async function pollJob(job) {
  let networkErrors = 0;
  let lastError = '';
  while (Date.now() - job.started < JOB_TIMEOUT_MS) {
    // Back off gently while the connection is down, up to 20 s between checks.
    await sleep(Math.min(POLL_MS * (1 + networkErrors), 20_000));
    let response;
    let data;
    try {
      response = await fetch(`/api/task?id=${encodeURIComponent(job.taskId)}`);
      data = await response.json();
    } catch {
      response = null;
    }
    // Network blips and 5xx errors are temporary: Lux3D keeps building on its side, so keep asking
    // until the job's own time limit instead of declaring a model that may be nearly done "failed".
    if (!response || response.status >= 500) {
      networkErrors++;
      lastError = data?.error || '';
      if (networkErrors >= 2 && job.state !== 'reconnecting') { job.resumeState = job.state; job.state = 'reconnecting'; renderJobs(); }
      continue;
    }
    if (job.state === 'reconnecting') job.state = job.resumeState ?? 'running';
    networkErrors = 0;
    if (!response.ok) throw new Error(data.error || `Status check failed (HTTP ${response.status}).`);
    if (data.state === 'failed') throw new Error(data.error || 'Lux3D could not build this model.');
    if (data.state === 'done') {
      const entry = { name: job.name, url: data.url, realHeight: job.realHeight, source: job.source, taskId: job.taskId };
      state.myModels.unshift(entry);
      try { localStorage.setItem('waterline-models', JSON.stringify(state.myModels.slice(0, 40))); } catch { /* Storage may be disabled. */ }
      renderLibrary();
      const template = await loadTemplate(entry);
      job.state = 'done';
      renderJobs();
      setPending(template);
      setTimeout(() => {
        state.jobs = state.jobs.filter((j) => j !== job);
        renderJobs();
      }, 6000);
      return;
    }
    job.state = data.state;
    renderJobs();
  }
  throw new Error(lastError ? `Lost contact with Lux3D (${lastError}). Press “Resume status check” to try again.` : 'This is taking too long. Try again with a clearer photo.');
}

/** The real height the user picked, or undefined to let Lux3D's estimate decide. */
function chosenHeight() {
  const kind = KINDS[Number($('#kind').value)] ?? KINDS[0];
  const custom = Number($('#kind-height').value);
  return kind.height ?? (custom > 0 ? custom : undefined);
}

async function startGeneration(payload, name) {
  if (state.jobs.filter(job => !['done', 'failed'].includes(job.state)).length >= 3) return toast('Wait for one of your current models to finish before starting another.');
  const job = { name, started: Date.now(), state: 'uploading', taskId: null, error: '', realHeight: chosenHeight(), source: payload.image ? 'lux3d-image-to-3d' : 'lux3d-text-to-3d' };
  state.jobs.push(job);
  renderJobs();
  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, name }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
    job.taskId = data.taskId;
    job.state = 'queued';
    renderJobs();
    await pollJob(job);
  } catch (error) {
    job.state = 'failed';
    job.error = error.message;
    renderJobs();
  }
}

async function fileToDataUrl(file, maxSide = 1600) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.9);
}

// ---------- flood controls ----------

// ---------- impact HUD ----------

const PERSON = /person|adult|child|people|\bman\b|woman/i;
const VEHICLE = /car|suv|truck|van|bus|scooter|motor|bike|pickup/i;
const DOOR = /door/i;

/** Plain-language state of one object at the current (flat) water level. */
function impactOf(obj) {
  const here = Math.max(0, state.pin.height + state.depth - obj.ground);
  const share = here / Math.max(obj.realHeight, 0.01);
  let text;
  if (here < 0.02) text = 'Dry';
  else if (PERSON.test(obj.name)) {
    text = share < 0.12 ? 'Ankle-deep' : share < 0.3 ? 'Knee-deep' : share < 0.55 ? 'Waist-deep'
      : share < 0.75 ? 'Chest-deep' : share < 0.9 ? 'Up to the neck' : 'Over their head';
  } else if (VEHICLE.test(obj.name)) {
    text = share >= 1 ? 'Completely under' : share >= 0.6 ? 'Up to the windows'
      : here >= 0.6 ? 'Moving water this deep sweeps vehicles away' : here >= 0.3 ? 'Moving water this deep can float it' : 'Wheels in water';
  } else if (DOOR.test(obj.name)) {
    text = share >= 1 ? 'Over the door' : here < 0.2 ? 'At the doorstep' : share < 0.5 ? 'Water coming inside' : 'More than half the door under';
  } else {
    text = share >= 1 ? 'Completely under' : `${Math.round(share * 100)}% under water`;
  }
  return { here, share, text, level: here < 0.02 ? 'low' : share >= 0.6 ? 'high' : share >= 0.2 || here >= 0.3 ? 'mid' : 'low' };
}

/** The "At this water level" panel on the map, plus one marker per object top on the water slider. */
function renderImpact() {
  const box = $('#impact');
  const ticks = $('#depth-ticks');
  const list = $('#impact-list');
  if (!box || !ticks || !list) return;
  // Only objects near your spot: one left behind in another city is not in this flood.
  const R = 6_378_137;
  const near = (o) => Math.hypot((o.lon - state.pin.lon) * R * Math.cos(state.pin.lat), (o.lat - state.pin.lat) * R) < 3000;
  const objects = state.pin ? state.objects.filter(near) : [];
  box.hidden = !objects.length;
  const key = objects.map((o) => `${o.id}:${o.name}`).join('|');
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.replaceChildren(...objects.map(() => {
      const li = el('li');
      const bar = el('span', 'i-bar');
      bar.append(el('span'));
      li.append(el('span', 'i-name'), el('span', 'i-depth'), el('span', 'i-state'), bar);
      return li;
    }));
  }
  objects.forEach((obj, i) => {
    const { here, share, text, level } = impactOf(obj);
    const [name, depth, status, bar] = list.children[i].children;
    list.children[i].dataset.level = level;
    name.textContent = obj.name;
    depth.textContent = here < 0.02 ? `${obj.realHeight.toFixed(2)} m tall` : `${here.toFixed(2)} m here`;
    status.textContent = text;
    bar.firstChild.style.width = `${Math.min(1, share) * 100}%`;
  });
  renderDepthTicks(objects);
}

/**
 * Slider markers at each object's top, so you can aim the water at it. Labels that would
 * overlap move to a second row; anything still colliding shares the previous label.
 */
function renderDepthTicks(objects) {
  const ticks = $('#depth-ticks');
  const tops = objects
    .map((obj) => ({ name: obj.name.length > 13 ? `${obj.name.slice(0, 12)}…` : obj.name, top: obj.ground - state.pin.height + obj.realHeight }))
    .filter((t) => t.top > 0 && t.top <= MAX_DEPTH_M)
    .sort((a, b) => a.top - b.top);
  const width = ticks.clientWidth;
  const sig = `${width}|${tops.map((t) => `${t.name}@${t.top.toFixed(2)}`).join(',')}`;
  if (ticks.dataset.sig !== sig) {
    ticks.dataset.sig = sig;
    const rowsEnd = [-Infinity, -Infinity];
    const labels = [];
    for (const t of tops) {
      const x = (t.top / MAX_DEPTH_M) * width;
      const half = (t.name.length * 7.6 + 22) / 2;
      const row = rowsEnd.findIndex((end) => x - half > end + 4);
      if (row === -1 && labels.length) {
        const prev = labels.at(-1);
        prev.names.push(t.name); prev.top = Math.max(prev.top, t.top);
        continue;
      }
      rowsEnd[Math.max(row, 0)] = x + half;
      labels.push({ names: [t.name], top: t.top, x, row: Math.max(row, 0) });
    }
    ticks.replaceChildren(...labels.map((label) => {
      const span = el('span', '', label.names.join(' · '));
      span.style.left = `${(label.x / Math.max(width, 1)) * 100}%`;
      span.dataset.row = String(label.row);
      span.dataset.top = String(label.top);
      return span;
    }));
    ticks.closest('.dock-slider')?.classList.toggle('two-rows', labels.some((l) => l.row === 1));
  }
  for (const span of ticks.children) span.classList.toggle('under', state.depth >= Number(span.dataset.top));
}

function renderFacts() {
  const list = $('#facts');
  if (list.children.length !== FACTS.length) list.replaceChildren(...FACTS.map((fact) => el('li', '', fact.text)));
  [...list.children].forEach((node, i) => node.classList.toggle('reached', state.depth >= FACTS[i].depth));
}

function setDepth(value, source = 'Manual illustration - not a forecast') {
  state.depthSource = source;
  $('#depth-source').textContent = source + (value > MAX_DEPTH_M ? ' - display capped at 3 m' : '');
  state.depth = Math.min(MAX_DEPTH_M, Math.max(0, value));
  $('#depth').value = String(state.depth);
  $('#depth-out').textContent = `${state.depth.toFixed(2)} m`;
  $('#map-depth-value').textContent = `${state.depth.toFixed(2)} m`;
  $('#depth').setAttribute('aria-valuetext', `${state.depth.toFixed(2)} metres`);
  $('#depth').style.setProperty('--fill', `${(state.depth / MAX_DEPTH_M) * 100}%`);
  renderImpact();
  document.querySelectorAll('.presets button').forEach((button) => {
    button.setAttribute('aria-pressed', String(Math.abs(Number(button.dataset.depth) - state.depth) < 0.005));
  });
  updateWater();
  renderFacts();
  if (state.safety && Math.abs(state.safety.depth - state.depth) > 0.01) {
    clearSafety('The water level changed. Press “Find higher ground” again.');
  }
}

function stopPlaying() {
  state.playResolve?.();
  state.playResolve = null;
  cancelAnimationFrame(state.playRaf);
  state.playRaf = 0;
  $('#play').textContent = 'Play the flood';
  $('#play').setAttribute('aria-pressed', 'false');
}

function playFlood(targetDepth, source = state.depthSource) {
  if (!state.pin) return toast('Choose your spot on the map first.');
  stopPlaying();
  const target = Number(targetDepth) > 0 ? Number(targetDepth) : state.depth >= 0.1 ? state.depth : 1.2;
  const start = performance.now();
  const duration = 8000;
  return new Promise((resolve) => {
    state.playResolve = resolve;
    $('#play').textContent = 'Pause flood';
    $('#play').setAttribute('aria-pressed', 'true');
    const step = (now) => {
      const k = Math.min(1, (now - start) / duration);
      const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      setDepth(target * eased, source);
      state.playRaf = k < 1 ? requestAnimationFrame(step) : 0;
      if (k >= 1) { state.playResolve = null; $('#play').textContent = 'Play the flood'; $('#play').setAttribute('aria-pressed', 'false'); resolve(); }
    };
    state.playRaf = requestAnimationFrame(step);
  });
}

function toggleOrbit() {
  const { viewer } = state;
  const button = $('#orbit');
  if (state.orbitOff) {
    state.orbitOff();
    state.orbitOff = null;
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    button.textContent = 'Orbit camera';
    return;
  }
  if (!state.pin) return toast('Choose your spot on the map first.');
  markView(null);
  const center = Cesium.Cartesian3.fromRadians(state.pin.lon, state.pin.lat, state.pin.height + 1);
  const range = Cesium.Math.clamp(Cesium.Cartesian3.distance(viewer.camera.positionWC, center), 15, 400);
  const pitch = Cesium.Math.clamp(viewer.camera.pitch, rad(-60), rad(-10));
  let heading = viewer.camera.heading;
  let previous = performance.now();
  state.orbitOff = viewer.scene.preRender.addEventListener(() => {
    const now = performance.now();
    heading += Math.min((now - previous) / 1000, .1) * .07;
    previous = now;
    viewer.camera.lookAt(center, new Cesium.HeadingPitchRange(heading, pitch, range));
  });
  button.textContent = 'Stop orbit';
}

async function cameraView(view) {
  if (!state.pin) return toast('Choose a street first.');
  if (state.orbitOff) toggleOrbit();
  const obj = state.selected ?? state.objects[0];
  const focus = view !== 'overview' && obj;
  const center = Cesium.Cartesian3.fromRadians(focus ? obj.lon : state.pin.lon, focus ? obj.lat : state.pin.lat, (focus ? obj.ground : state.pin.height) + (view === 'overview' ? 1 : .9));
  const preset = view === 'overview' ? { heading: 15, pitch: -52, range: 105 } : view === 'focus' ? { heading: 35, pitch: -13, range: 11 } : { heading: 22, pitch: -15, range: 23 };
  await flyAround(center, preset, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1.6);
  markView(view);
}

/** Highlight the camera preset in use; null when the camera is somewhere else. */
function markView(view) {
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
}

// ---------- share links ----------

function sceneData() {
  const { camera } = state.viewer;
  const cam = Cesium.Cartographic.fromCartesian(camera.positionWC);
  const data = {
    v: 1,
    m: state.mode,
    p: state.pin ? [round(deg(state.pin.lon), 7), round(deg(state.pin.lat), 7), round(state.pin.height, 2)] : null,
    d: round(state.depth, 2),
    o: state.objects.map((o) => ({
      u: o.url,
      n: o.name,
      x: round(deg(o.lon), 7),
      y: round(deg(o.lat), 7),
      g: round(o.ground, 2),
      h: round(o.realHeight, 2),
      r: Math.round(o.heading),
    })),
    c: [round(deg(cam.longitude), 7), round(deg(cam.latitude), 7), round(cam.height, 1), round(deg(camera.heading), 1), round(deg(camera.pitch), 1)],
  };
  return validateScene(data);
}

async function copyShareLink() {
  const data = sceneData();
  const target = new URL(location.href);
  target.searchParams.set('mode', state.mode);
  target.hash = `s=${encodeBase64Url(JSON.stringify(data))}`;
  const link = target.href;
  history.replaceState(null, '', link);
  try {
    await navigator.clipboard.writeText(link);
    toast('Link copied. Paste it into your post!');
  } catch {
    toast('Copy the link from your address bar.');
  }
}

function downloadFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = el('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function saveScene() {
  try { downloadFile(new Blob([JSON.stringify(sceneData(), null, 2)], { type: 'application/json' }), 'waterline-scene.json'); }
  catch (error) { toast(error.message); }
}

async function openSceneFile(file) {
  if (!file || file.size > 100_000) throw new Error('Choose a Waterline scene JSON smaller than 100 KB.');
  const data = validateScene(JSON.parse(await file.text()));
  const target = new URL(location.href);
  target.searchParams.set('mode', data.m ?? 'street');
  target.hash = `s=${encodeBase64Url(JSON.stringify(data))}`;
  if (target.pathname + target.search === location.pathname + location.search) {
    history.replaceState(null, '', target.href);
    location.reload();
  } else location.href = target.href;
}

function saveSnapshot() {
  if (state.mode !== 'studio') return toast('Use a browser screenshot for real maps so provider attribution stays visible.');
  const viewer = state.viewer;
  viewer.render();
  const frame = document.createElement('canvas');
  frame.width = viewer.canvas.width; frame.height = viewer.canvas.height;
  const ctx = frame.getContext('2d');
  ctx.drawImage(viewer.canvas, 0, 0);
  ctx.fillStyle = '#163d38'; ctx.fillRect(0, frame.height - 80, frame.width, 80);
  ctx.fillStyle = '#ffffff'; ctx.font = '18px sans-serif';
  ctx.fillText(`Waterline · ${state.depth.toFixed(2)} m · ${state.mode === 'studio' ? 'Illustrative studio' : 'Real street'}`, 20, frame.height - 46);
  ctx.font = '12px sans-serif';
  ctx.fillText('Illustration, not a forecast. Core SUV created with Aholo Lux3D. Follow official warnings.', 20, frame.height - 22);
  frame.toBlob((blob) => blob ? downloadFile(blob, 'waterline-view.png') : toast('Image export unavailable.'), 'image/png');
}

async function restoreFromHash() {
  const match = /^#s=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!match) return false;
  let data;
  try {
    if (match[1].length > 140_000) throw new Error('Scene too large');
    data = validateScene(JSON.parse(decodeBase64Url(match[1])));
  } catch {
    toast('That share link looks broken.');
    return false;
  }
  if (Array.isArray(data.c)) {
    const [x, y, h, heading, pitch] = data.c.map(Number);
    if (allFinite(x, y, h, heading, pitch)) {
      state.viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(x, y, h),
        orientation: { heading: rad(heading), pitch: rad(pitch), roll: 0 },
      });
    }
  }
  if (Array.isArray(data.p)) {
    const [x, y, h] = data.p.map(Number);
    if (allFinite(x, y, h)) setPin(Cesium.Cartographic.fromDegrees(x, y, h));
  }
  for (const o of Array.isArray(data.o) ? data.o : []) {
    const [x, y, g] = [Number(o?.x), Number(o?.y), Number(o?.g)];
    if (typeof o?.u !== 'string' || !o.u.startsWith('/models/') || !allFinite(x, y, g)) continue;
    try {
      const template = await loadTemplate({ name: String(o.n ?? 'Object').slice(0, 60), url: o.u });
      placeObject(template, Cesium.Cartographic.fromDegrees(x, y, g), {
        realHeight: Number(o.h) > 0 ? Number(o.h) : undefined,
        heading: Number(o.r) || 0,
      });
    } catch (error) {
      console.warn('Could not restore object', o, error);
    }
  }
  setDepth(Number(data.d) || 0, 'Shared illustration - not a forecast');
  return true;
}

// ---------- real-flood scenes ----------

function photorealisticTiles() {
  const { primitives } = state.viewer.scene;
  for (let i = 0; i < primitives.length; i++) {
    const primitive = primitives.get(i);
    if (primitive instanceof Cesium.Cesium3DTileset) return primitive;
  }
  return null;
}

async function waitForTiles(maxMs = 10_000) {
  const tiles = photorealisticTiles();
  const start = performance.now();
  while (tiles && !tiles.tilesLoaded && performance.now() - start < maxMs) await sleep(250);
}

/** Street height at a point: the lowest of nine samples within 2 m, so a tree or roof never counts. */
async function groundHeightAt(lon, lat) {
  const points = [];
  for (const dx of [-2, 0, 2]) for (const dy of [-2, 0, 2]) points.push(offsetCarto(rad(lon), rad(lat), dx, dy));
  if (photorealisticTiles()) {
    const exclude = [...state.gauge, ...state.safetyEntities, ...state.objects.map((o) => o.entity)];
    await state.viewer.scene.sampleHeightMostDetailed(points, exclude);
  } else {
    await sampleHeights(points);
  }
  const heights = points.map((p) => p.height).filter(Number.isFinite);
  if (!heights.length) throw new Error('no height data here');
  return Math.min(...heights);
}

function flyAround(center, view, duration = 3) {
  return new Promise((resolve) => {
    state.viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, 2), {
      offset: new Cesium.HeadingPitchRange(rad(view.heading), rad(view.pitch), view.range),
      duration,
      complete: resolve,
      cancel: resolve,
    });
  });
}

async function openScene(scene) {
  if (state.mode === 'studio') return openStudioScene(true);
  stopPlaying();
  if (state.orbitOff) toggleOrbit();
  setDepth(0);
  const story = $('#scene-story');
  story.hidden = false;
  story.textContent = `Flying to ${scene.button}…`;
  toast(`Flying to ${scene.button}. The 3D city takes a few seconds to load…`, 8000);
  const templates = (scene.objects ?? []).map((item) => {
    const entry = state.library.find((e) => e.id === item.id);
    return entry ? loadTemplate(entry).catch(() => null) : Promise.resolve(null);
  });

  // Rough height from terrain so the camera lands in the right place, then the exact street height from the 3D city.
  const rough = scene.ground ?? (await sampleHeights([Cesium.Cartographic.fromDegrees(scene.lon, scene.lat)]))[0].height ?? 0;
  await flyAround(Cesium.Cartesian3.fromDegrees(scene.lon, scene.lat, rough + 1), { heading: scene.view.heading, pitch: -35, range: 140 });
  markView(null);
  await waitForTiles(6000);
  const ground = scene.ground ?? await groundHeightAt(scene.lon, scene.lat);
  const pin = Cesium.Cartographic.fromDegrees(scene.lon, scene.lat, ground);
  setPin(pin);

  // Park the Lux3D SUV and an adult near the gauge, each on the 3D city's own ground there.
  // Objects from any example scene (here or in the other city) are cleared first.
  state.objects.filter((o) => o.sceneId).forEach(removeObject);
  const heading = rad(scene.view.heading);
  const along = ({ ahead, right }) => [ahead * Math.sin(heading) + right * Math.cos(heading), ahead * Math.cos(heading) - right * Math.sin(heading)];
  const spots = (scene.objects ?? []).map((item) => { const [east, north] = along(item); return offsetCarto(pin.longitude, pin.latitude, east, north); });
  const heights = await Promise.all(spots.map((spot) =>
    groundHeightAt(Cesium.Math.toDegrees(spot.longitude), Cesium.Math.toDegrees(spot.latitude)).catch(() => ground)));
  for (const [i, item] of (scene.objects ?? []).entries()) {
    const template = await templates[i];
    if (!template) continue;
    // Never trust a sample more than 1.5 m off the street (a wall or a car roof).
    spots[i].height = Number.isFinite(heights[i]) && Math.abs(heights[i] - ground) <= 1.5 ? heights[i] : ground;
    const obj = placeObject(template, spots[i], { heading: scene.view.heading + item.turn });
    obj.sceneId = scene.id;
  }

  // Close framing, centred between the placed objects.
  const placed = (scene.objects ?? []).map(along);
  const [east, north] = placed.length ? placed.reduce(([a, b], [c, d]) => [a + c / placed.length, b + d / placed.length], [0, 0]) : [0, 0];
  const focus = offsetCarto(pin.longitude, pin.latitude, east, north);
  await flyAround(Cesium.Cartesian3.fromRadians(focus.longitude, focus.latitude, ground + 1), scene.view, 2.2);
  story.textContent = scene.story;
  await waitForTiles(4000);
  await playFlood(scene.depth, 'Example scene - illustrative depth, not measured event depth');
  toast('Now press “Find higher ground” to see where to go.', 6000);
}

async function openStudioScene(animate = false) {
  stopPlaying();
  if (state.orbitOff) toggleOrbit();
  setDepth(0, 'Studio illustration - synthetic terrain, not a forecast');
  const pin = Cesium.Cartographic.fromDegrees(STUDIO.lon, STUDIO.lat, .07);
  setPin(pin);
  state.objects.filter((o) => o.sceneId === 'studio').forEach(removeObject);
  const entry = state.library.find((e) => e.source?.startsWith('lux3d'));
  if (!entry) throw new Error('The Lux3D Library model is unavailable. Check the installation.');
  const template = await loadTemplate(entry);
  const spot = offsetCarto(pin.longitude, pin.latitude, -3, 5); spot.height = .07;
  const obj = placeObject(template, spot, { heading: 0 }); obj.sceneId = 'studio';
  await flyAround(Cesium.Cartesian3.fromRadians(spot.longitude, spot.latitude, 1), { heading: 22, pitch: -15, range: 23 }, animate ? 1.8 : 0);
  markView('street'); // same framing as the Street view preset
  $('#scene-story').hidden = false;
  $('#scene-story').textContent = 'An original illustrative street, a real Aholo Lux3D-generated SUV, and a rising water plane. The hill and route in this mode are synthetic examples.';
  if (animate) await playFlood(1.2, 'Studio illustration - synthetic terrain, not a forecast');
}

// ---------- clicks + UI wiring ----------

let groundPickId = 0;
async function onMapClick(event) {
  const pickId = ++groundPickId;
  const pending = state.pending, moving = state.moving;
  const { scene } = state.viewer;
  const picked = scene.pick(event.position);
  const hit = picked && state.objects.find((o) => o.entity === picked.id);
  if (hit && !state.pending && !state.moving) {
    selectObject(hit);
    return;
  }
  const carto = await pickGround(Cesium, state.viewer, event.position, {
    studioPick: state.mode === 'studio' ? (ray) => pickStudioGround(Cesium, ray) : undefined,
    sampleGround: async (point) => {
      if (photorealisticTiles()) {
        const exclude = [state.water, ...state.gauge, ...state.safetyEntities, ...state.objects.map((o) => o.entity)].filter(Boolean);
        const [sample] = await within(scene.sampleHeightMostDetailed([point], exclude), 8000);
        return sample?.height;
      }
      const [sample] = await within(sampleHeights([point]), 8000);
      return sample?.height;
    },
  });
  if (pickId !== groundPickId || pending !== state.pending || moving !== state.moving) return;
  if (!carto) {
    toast(state.mode === 'studio' ? 'Click the visible demo street or hillside to place your object.' : 'Street data is still loading here. Zoom toward a visible street, wait a moment, then click again.');
    return;
  }
  if (state.mode === 'studio') carto.height = studioHeight(carto.longitude, carto.latitude) + .07;
  if (state.moving) {
    rememberObjects();
    const obj = state.moving;
    Object.assign(obj, {lon: carto.longitude, lat: carto.latitude, ground: carto.height});
    applyObject(obj); setPending(null); selectObject(obj); toast('Object moved.');
  } else if (state.pending) {
    const obj = placeObject(state.pending, carto, {heading: state.pending.heading ?? 0});
    setPending(null);
    if (!state.pin) setPin(carto);
    selectObject(obj);
    toast(pending?.sizeGuessed
      ? `Lux3D didn’t say how big “${obj.name}” is, so it stands 1.5 m tall. Type its real height in the list.`
      : `Placed “${obj.name}” at ${obj.realHeight.toFixed(2)} m tall. Adjust its height and direction in the list.`, 8000);
  } else {
    setPin(carto);
  }
}

// ---------- homepage + one space per function ----------

let markReady;
const appReady = new Promise((resolve) => { markReady = resolve; });

/** Show one function's space in the panel (Spot, Things, Water, Risk, Safety, Detective, Share). */
function showSpace(name) {
  const spaces = [...document.querySelectorAll('.space')];
  if (!spaces.some((space) => space.dataset.space === name)) return;
  spaces.forEach((space) => { space.hidden = space.dataset.space !== name; });
  document.querySelectorAll('.rail [data-go]').forEach((button) => button.setAttribute('aria-current', String(button.dataset.go === name)));
  $('#panel').scrollTop = 0;
}

function leaveHome() {
  document.documentElement.classList.remove('home-open');
  state.viewer?.resize();
}

function wireHome() {
  // While the homepage covers the app, the app behind it can't be tabbed into or clicked.
  const syncInert = () => { $('#app').inert = document.documentElement.classList.contains('home-open'); };
  new MutationObserver(syncInert).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  syncInert();
  $('#home-demo-2')?.addEventListener('click', () => $('#home-demo').click());
  document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => showSpace(button.dataset.go)));
  document.querySelector('[data-home]')?.addEventListener('click', () => document.documentElement.classList.add('home-open'));
  $('#home-demo').onclick = async () => {
    leaveHome();
    showSpace('spot');
    await appReady;
    $('#demo-go').click();
  };
  $('#home-studio').onclick = () => {
    if (state.mode === 'studio') { leaveHome(); showSpace('things'); return; }
    const url = new URL(location.href); url.searchParams.set('mode', 'studio'); url.hash = ''; location.href = url.href;
  };
  $('#home-street').onclick = () => {
    leaveHome();
    if (state.mode !== 'street') { showSpace('spot'); return toast('Real streets need a Cesium ion token on this server, so here is the studio street.', 7000); }
    showSpace('spot');
    toast('Type your address in the search box at the top right, then click your street.', 7000);
    document.querySelector('.cesium-geocoder-input')?.focus();
  };
}

function wireUi() {
  wireHome();
  document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => cameraView(button.dataset.view).catch(error => toast(error.message)); });
  $('#cinema').onclick = () => {
    const cinema = $('#app').classList.toggle('cinema');
    $('#cinema').textContent = cinema ? 'Show controls' : 'Cinema view';
    $('#cinema').setAttribute('aria-pressed', String(cinema));
    state.viewer?.resize();
  };
  $('#world-mode').value = state.mode;
  $('#world-mode').onchange = (event) => {
    const url = new URL(location.href); url.searchParams.set('mode', event.target.value); url.hash = ''; location.href = url.href;
  };
  $('#save-scene').onclick = saveScene;
  $('#load-scene').onclick = () => $('#scene-file').click();
  $('#scene-file').onchange = (event) => openSceneFile(event.target.files?.[0]).catch((error) => toast(error.message));
  $('#snapshot').onclick = () => { try { saveSnapshot(); } catch { toast('Image export unavailable. Try a browser screenshot.'); } };
  $('#snapshot').disabled = state.mode !== 'studio';
  $('#snapshot').title = state.mode === 'studio' ? 'Export the illustrative 3D view' : 'For real maps, use a browser screenshot that retains provider attribution';
  $('#undo').onclick = undoObjects;
  $('#demo-go').onclick = async () => {
    const button = $('#demo-go'); button.disabled = true;
    $('#demo-status').textContent = 'Loading street and Lux3D SUV...';
    try { await openScene(SCENES[0]); $('#demo-status').textContent = 'Demo ready. Adjust the depth or try Depth detective.'; }
    catch(error) { $('#demo-status').textContent = 'Demo could not load: ' + error.message + '. Try again.'; }
    finally { button.disabled = false; }
  };
  $('#challenge-go').onclick = async () => {
    const button = $('#challenge-go'); const guess = Number($('#challenge-guess').value);
    if (!$('#challenge-guess').value || !Number.isFinite(guess) || guess < 0 || guess > 3) return toast('Enter a prediction between 0 and 3 metres.');
    const entry = state.library.find(e => e.id === $('#challenge-object').value);
    if (!entry) return toast('Comparison library unavailable. Reload and try again.');
    if (!state.pin) return toast('Try the demo or choose a street first.');
    button.disabled = true;
    try {
      const template = await loadTemplate(entry);
      state.objects.filter(o => o.challenge).forEach(removeObject);
      const spot = clearSpotNearPin(template); spot.height = state.pin.height;
      const obj = placeObject(template, spot); obj.challenge = true;
      const difference = Math.abs(guess - entry.realHeight);
      $('#challenge-result').textContent = (difference <= 0.15 ? 'Good estimate! ' : 'Compare your prediction. ') + 'You chose ' + guess.toFixed(1) + ' m; this object is ' + entry.realHeight.toFixed(2) + ' m tall. Difference: ' + difference.toFixed(2) + ' m. Water can become dangerous well before the top is covered.';
      await playFlood(entry.realHeight, 'Height challenge - illustrative comparison');
    } catch(error) { $('#challenge-result').textContent = 'Could not load comparison: ' + error.message + '. Try again.'; }
    finally { button.disabled = false; }
  };
  document.querySelectorAll('.tab-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === button));
      document.querySelectorAll('.tab-btn').forEach((b) => {
        b.setAttribute('aria-selected', String(b === button));
        b.tabIndex = b === button ? 0 : -1;
      });
      document.querySelectorAll('.tab').forEach((tab) => { tab.hidden = tab.dataset.tab !== button.dataset.tab; });
      $('#kind-row').hidden = button.dataset.tab === 'library'; // library models carry their own size
    });
    button.addEventListener('keydown', (event) => {
      const tabs = [...document.querySelectorAll('.tab-btn')];
      let index = tabs.indexOf(button);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault();
      tabs[index].focus();
      tabs[index].click();
    });
  });

  const kindSelect = $('#kind');
  kindSelect.replaceChildren(...KINDS.map((kind, i) => {
    const option = el('option', '', kind.height ? `${kind.label} (${kind.height} m tall)` : kind.label);
    option.value = String(i);
    return option;
  }));
  kindSelect.addEventListener('change', () => {
    $('#kind-height').hidden = KINDS[Number(kindSelect.value)].height !== null;
  });

  let photoFile = null;
  const photoGo = $('#photo-go');
  $('#photo-input').addEventListener('change', (event) => {
    photoFile = event.target.files?.[0] ?? null;
    const preview = $('#photo-preview');
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.hidden = !photoFile;
    if (photoFile) preview.src = URL.createObjectURL(photoFile);
    photoGo.disabled = !photoFile || !state.generationEnabled;
  });
  photoGo.addEventListener('click', async () => {
    if (!photoFile) return;
    let image;
    try {
      image = await fileToDataUrl(photoFile);
    } catch {
      toast('Could not read this photo. Try a JPEG or PNG.');
      return;
    }
    startGeneration({ image }, $('#photo-name').value.trim() || 'My object');
  });

  $('#text-go').addEventListener('click', () => {
    const prompt = $('#text-prompt').value.trim();
    if (prompt.length < 3) return toast('Describe the object in a few words first.');
    startGeneration({ prompt }, prompt.slice(0, 40));
  });
  document.querySelectorAll('[data-example]').forEach((chip) => {
    chip.addEventListener('click', () => { $('#text-prompt').value = chip.dataset.example; $('#text-prompt').focus(); });
  });

  if (!state.generationEnabled) {
    const note = $('#gen-note');
    note.hidden = false;
    note.textContent = 'Making new models is switched off on this server. Use the Library tab.';
    photoGo.disabled = true;
    $('#text-go').disabled = true;
  }

  $('#depth').addEventListener('input', (event) => {
    stopPlaying();
    setDepth(Number(event.target.value));
  });
  document.querySelectorAll('.presets button').forEach((button) => {
    button.addEventListener('click', () => {
      stopPlaying();
      setDepth(Number(button.dataset.depth));
    });
  });
  $('#play').addEventListener('click', () => state.playRaf ? stopPlaying() : playFlood());
  $('#scenes').replaceChildren(...SCENES.map((scene) => {
    // "Kerrville, Texas · July 2025" → place on top, date underneath.
    const [place, when] = scene.button.split(' · ');
    const button = el('button', 'scene-card');
    button.setAttribute('aria-label', scene.button);
    button.append(el('strong', '', place), el('span', '', when ?? ''));
    button.addEventListener('click', () => openScene(scene).catch((error) => toast(`Couldn’t open this place: ${error.message}`)));
    return button;
  }));
  $('#scenes').hidden = state.mode === 'studio';
  $('#scenes-hint').hidden = state.mode === 'studio';
  $('#safe-go').addEventListener('click', findHigherGround);
  $('#orbit').addEventListener('click', toggleOrbit);
  $('#share').addEventListener('click', copyShareLink);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (state.pending || state.moving)) setPending(null);
    if (event.key === 'Escape' && $('#app').classList.contains('cinema')) $('#cinema').click();
  });

  setInterval(() => {
    if (state.jobs.some((j) => j.state !== 'done' && j.state !== 'failed')) renderJobs();
  }, 1000);
}

async function init() {
  if (!Cesium) throw new Error('The 3D engine could not load. Run npm install, then restart the server.');
  const config = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  const requestedMode = new URLSearchParams(location.search).get('mode');
  const requestedStreet = requestedMode === 'street' || (!requestedMode && !!config.cesiumToken);
  state.mode = requestedStreet && config.cesiumToken ? 'street' : 'studio';
  Cesium.Ion.defaultAccessToken = config.cesiumToken || '';
  state.generationEnabled = Boolean(config.generationEnabled);
  if (requestedStreet && !config.cesiumToken) toast('Real streets need a Cesium token. Studio is ready to explore instead.', 8000);
  try {
    const saved = JSON.parse(localStorage.getItem('waterline-models') || '[]');
    state.myModels = Array.isArray(saved) ? saved.filter((entry) => /^\/models\/generated\/\d+\.glb$/.test(entry?.url) && typeof entry.name === 'string').slice(0, 40) : [];
  } catch { /* Fresh or unavailable browser storage. */ }
  try {
    const jobs = JSON.parse(localStorage.getItem('waterline-jobs') || '[]');
    if (Array.isArray(jobs)) state.jobs = jobs.filter(job => /^\d{1,30}$/.test(job?.taskId) && typeof job.name === 'string').slice(-10).map(job => ({
      name: job.name.slice(0, 60), taskId: job.taskId, realHeight: Number.isFinite(job.realHeight) && job.realHeight > 0 && job.realHeight <= 30 ? job.realHeight : undefined,
      source: ['lux3d-image-to-3d', 'lux3d-text-to-3d'].includes(job.source) ? job.source : 'lux3d-text-to-3d',
      state: 'failed', error: 'Task restored. Resume checking without creating a new model.', started: Date.now(),
    }));
  } catch { /* Fresh or unavailable browser storage. */ }

  const viewer = new Cesium.Viewer('map', {
    scene3DOnly: true,
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    homeButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    baseLayer: false, // Google's 3D tiles carry their own imagery; the fallback adds a layer
    geocoder: state.mode === 'street' ? Cesium.IonGeocodeProviderType.GOOGLE : false,
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
  });
  state.viewer = viewer;
  $('#map').classList.toggle('real-map', state.mode === 'street');
  viewer.scene.postProcessStages.fxaa.enabled = true;
  viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);
  const controls = viewer.scene.screenSpaceCameraController;
  controls.inertiaSpin = .82; controls.inertiaTranslate = .75; controls.inertiaZoom = .65;
  controls.zoomFactor = 2.5;
  controls.minimumZoomDistance = 3;
  controls.maximumZoomDistance = 20_000_000;

  wireUi();
  renderFacts();
  renderJobs();
  if (state.mode === 'studio') {
    state.studioStats = await createStudio(Cesium, viewer);
    viewer.shadowMap.size = window.innerWidth < 761 ? 1024 : 2048;
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
  }
  else await loadWorld(viewer);
  state.water = createWater(viewer);
  await loadLibrary();
  $('#world-status').textContent = state.mode === 'studio' ? 'Ready · illustrative terrain, no live hazard data.' : state.worldKind === 'photorealistic' ? 'Real street · photorealistic city, modelled river data.' : 'Real street · terrain fallback, modelled river data.';
  $('#map-mode-label').textContent = state.mode === 'studio' ? 'STUDIO · ILLUSTRATIVE STREET' : 'REAL STREET · LIVE MAP';
  if (state.mode === 'street') {
    $('#location-help').textContent = 'Search an address on the map, then click the street to choose your spot.';
    $('#demo-description').textContent = 'Visit Kerrville, Texas, with a Lux3D car for scale and an illustrative rising flood.';
  }
  new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
    .setInputAction(onMapClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  window.addEventListener('resize', () => renderImpact());
  // Dragging or zooming leaves the preset framing, so un-highlight the camera buttons.
  const leftPreset = () => markView(null);
  viewer.scene.canvas.addEventListener('wheel', leftPreset, { passive: true });
  viewer.scene.canvas.addEventListener('pointermove', (event) => { if (event.buttons) leftPreset(); });
  if (state.mode !== 'studio') markView(null);

  // ?debug exposes internals for testing in the browser console.
  if (new URLSearchParams(location.search).has('debug')) {
    window.waterline = {
      state, undoObjects, renderRisk, removeObject, setPending, copyShareLink, restoreFromHash, setPin, setDepth, loadTemplate, placeObject, playFlood, findHigherGround, openScene, SCENES, groundHeightAt, sceneData,
      setHeightSampler: (fn) => { heightSampler = fn; },
    };
  }

  if (!(await restoreFromHash())) {
    const onHome = document.documentElement.classList.contains('home-open');
    if (state.mode === 'studio') await openStudioScene();
    // From the homepage, the visitor chooses; a direct app link starts the real-street demo.
    else if (!onHome && !new URLSearchParams(location.search).has('nodemo')) $('#demo-go').click();
    else if (!onHome) toast('Search your address in the box at the top right, then click your street.', 7000);
  }
  markReady();
}

init().catch((error) => {
  console.error(error);
  showSetupError(`Something went wrong while starting the map: ${error.message}`);
});
