// Waterline area flood: samples bare-earth terrain around your spot, runs the connected-bathtub
// simulation from sim.js, draws the flooded area (realistic water up close, depth colours from
// above), and counts the buildings, roads and facilities it reaches (OpenStreetMap data).
import {
  BANDS, bandOf, gridPoints, cellAt, patchHeights, floodOnset, lowestCells, floodStats, levelForVolume, fitPlane, detrend, medianFilter, localGround, lowestNear, openWaterMask,
} from './sim.js';

export const AREA_SIZE_M = 1800;
export const AREA_CELLS = 90; // 20 m cells
const OSM_RADIUS_M = 900;
const REBUILD_MS = 160;
const CUT_DEPTH_M = 0.3; // moving water this deep floats cars: treat the road as cut
const FACILITY_LABELS = {
  hospital: 'Hospital', clinic: 'Clinic', school: 'School', kindergarten: 'Nursery', fire_station: 'Fire station',
  police: 'Police', shelter: 'Shelter', pharmacy: 'Pharmacy', substation: 'Substation', care_home: 'Care home',
};

const R = 6_378_137;
function metres(a, b) {
  const x = (b[0] - a[0]) * (Math.PI / 180) * R * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const y = (b[1] - a[1]) * (Math.PI / 180) * R;
  return Math.hypot(x, y);
}

export function createArea({ Cesium, viewer, sampleHeights, onStatus = () => {}, onStats = () => {} }) {
  const scene = viewer.scene;
  let area = null;
  let buildId = 0;
  let waterPrim = null;
  let depthPrim = null;
  let builtKey = '';
  let lastBuild = 0;
  let pendingTimer = 0;
  let current = null; // { level, rain }
  let depthView = false;
  const layers = { water: true, buildings: true, roads: true, facilities: true, depth: 'auto' };
  const points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const roadLines = scene.primitives.add(new Cesium.PolylineCollection());
  const facilityEntities = [];

  // ---------- geometry ----------

  function lattice() {
    const { n, sizeM, cellM } = area.grid;
    const side = n + 1;
    const positions = new Float64Array(side * side * 3);
    const normals = new Float32Array(side * side * 3);
    const st = new Float32Array(side * side * 2);
    const { a, b } = area.plane;
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const v = j * side + i;
        const east = -sizeM / 2 + i * cellM;
        const north = -sizeM / 2 + j * cellM;
        positions[v * 3] = east;
        positions[v * 3 + 1] = north;
        positions[v * 3 + 2] = a * east + b * north; // the water surface slopes with the valley
        normals[v * 3 + 2] = 1;
        st[v * 2] = i / n;
        st[v * 2 + 1] = j / n;
      }
    }
    return { positions, normals, st };
  }

  function geometryFor(cells, withSurface) {
    const { n, sizeM } = area.grid;
    const side = n + 1;
    const indices = new Uint16Array(cells.length * 6);
    cells.forEach((k, m) => {
      const i = k % n;
      const j = (k - i) / n;
      const v00 = j * side + i;
      const v10 = v00 + 1;
      const v01 = v00 + side;
      const v11 = v01 + 1;
      indices.set([v00, v10, v11, v00, v11, v01], m * 6);
    });
    const attributes = {
      position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: area.lattice.positions }),
    };
    if (withSurface) {
      attributes.normal = new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: area.lattice.normals });
      attributes.st = new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: area.lattice.st });
    }
    return new Cesium.Geometry({
      attributes,
      indices,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: new Cesium.BoundingSphere(new Cesium.Cartesian3(0, 0, 0), (sizeM / 2) * Math.SQRT2),
    });
  }

  // Same muddy water as the street plane, fading out at the edge of the simulated square.
  function waterMaterial() {
    const material = new Cesium.Material({
      translucent: true,
      fabric: {
        type: 'AreaFloodWater',
        uniforms: {
          normalMap: Cesium.buildModuleUrl('Assets/Textures/waterNormals.jpg'),
          baseColor: new Cesium.Color(0.19, 0.25, 0.23, 0.93),
          frequency: AREA_SIZE_M * 0.8,
          elapsedSeconds: 0,
        },
        source: `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material m = czm_getDefaultMaterial(materialInput);
  vec4 noise = czm_getWaterNoise(normalMap, materialInput.st * frequency, elapsedSeconds * 0.06, 0.0);
  vec3 n = normalize(noise.xyz * vec3(1.0, 1.0, 0.8));
  m.normal = normalize(czm_normal * n);
  float facing = clamp(dot(normalize(materialInput.positionToEyeEC), m.normal), 0.0, 1.0);
  float fresnel = pow(1.0 - facing, 4.0);
  m.diffuse = mix(baseColor.rgb, vec3(0.42, 0.51, 0.54), fresnel * 0.65) + 0.025 * n.z;
  vec2 edge = abs(materialInput.st - 0.5);
  m.alpha = baseColor.a * (1.0 - smoothstep(0.43, 0.5, max(edge.x, edge.y)));
  m.specular = 0.8;
  m.shininess = 64.0;
  return m;
}`,
      },
    });
    const started = performance.now();
    scene.preRender.addEventListener(() => { material.uniforms.elapsedSeconds = (performance.now() - started) / 1000; });
    return material;
  }
  let sharedMaterial = null;

  function removePrims() {
    for (const prim of [waterPrim, depthPrim]) if (prim) scene.primitives.remove(prim);
    waterPrim = null;
    depthPrim = null;
  }

  function frameAt(level) {
    return Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(area.grid.lon, area.grid.lat, level + area.offset));
  }

  // ---------- draw one water level ----------

  function wetCells(level, onset) {
    const cells = [];
    for (let k = 0; k < onset.length; k++) if (onset[k] < level && level - area.heights[k] >= 0.02) cells.push(k);
    return cells;
  }

  function rebuild() {
    if (!area || !current) return;
    lastBuild = performance.now();
    const { level, onset } = current;
    const cells = Number.isFinite(level) ? wetCells(level, onset) : [];
    const key = cells.length ? `${cells.length}:${cells[0]}:${cells.at(-1)}:${level.toFixed(2)}` : 'dry';
    if (key !== builtKey) {
      builtKey = key;
      removePrims();
      if (cells.length) {
        try {
          sharedMaterial ??= waterMaterial();
          waterPrim = scene.primitives.add(new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({ geometry: geometryFor(cells, true) }),
            appearance: new Cesium.MaterialAppearance({ material: sharedMaterial, materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED, translucent: true, faceForward: true }),
            asynchronous: false, allowPicking: false, modelMatrix: frameAt(level),
          }));
          const byBand = BANDS.map(() => []);
          for (const k of cells) byBand[Math.max(0, bandOf(level - area.heights[k]))].push(k);
          const instances = byBand.flatMap((band, b) => (band.length ? [new Cesium.GeometryInstance({
            geometry: geometryFor(band, false),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(BANDS[b].color).withAlpha(0.78)) },
          })] : []));
          depthPrim = scene.primitives.add(new Cesium.Primitive({
            geometryInstances: instances,
            appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
            asynchronous: false, allowPicking: false, modelMatrix: frameAt(level + 0.05),
          }));
        } catch (error) {
          console.warn('Area water could not be drawn.', error);
          removePrims();
        }
      }
      showLayers();
    }
    drawImpacts(level, onset);
  }

  function showLayers() {
    const deep = layers.depth === 'on' || (layers.depth === 'auto' && depthView);
    if (waterPrim) waterPrim.show = layers.water && !deep;
    if (depthPrim) depthPrim.show = layers.water && deep;
    points.show = layers.buildings;
    roadLines.show = layers.roads;
    facilityEntities.forEach((entity) => { entity.show = layers.facilities; });
  }

  // From high up, depth colours read better than realistic water; at street level the reverse.
  scene.preRender.addEventListener(() => {
    if (!area) return;
    const camera = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
    const high = camera && camera.height - (area.terrainPin + area.offset) > 320;
    if (high !== depthView) { depthView = high; showLayers(); }
  });

  // ---------- impacts ----------

  const C = (css, a = 1) => Cesium.Color.fromCssColorString(css).withAlpha(a);
  const DRY_POINT = C('#ffffff', 0.28);
  const BAND_COLORS = BANDS.map((b) => C(b.color, 1));
  const CUT = C('#ff5a3c', 0.95);
  const WET_ROAD = C('#ffb547', 0.9);

  function depthAtCell(cell, level, onset) {
    if (cell < 0 || !(onset[cell] < level)) return 0;
    return Math.max(0, level - area.heights[cell]);
  }

  function drawImpacts(level, onset) {
    const osm = area.osm;
    const stats = { ...floodStats(area.heights, onset, level, area.grid.cellM ** 2), level, osm: Boolean(osm) };
    if (osm) {
      let wet = 0;
      let deep = 0;
      const byBand = BANDS.map(() => 0);
      osm.buildings.forEach((b, i) => {
        const d = depthAtCell(b.cell, level, onset);
        const point = osm.points[i];
        const band = bandOf(d);
        if (band >= 0) { wet++; byBand[band]++; if (d >= 1.2) deep++; }
        if (point) {
          point.color = band >= 0 ? BAND_COLORS[band] : DRY_POINT;
          point.pixelSize = band >= 0 ? 7 : 4;
        }
      });
      roadLines.removeAll();
      let cutM = 0;
      const cutNames = new Map();
      for (const road of osm.roads) {
        let run = [];
        let runCut = false;
        const flush = () => {
          if (run.length > 1) {
            roadLines.add({
              positions: run.map(([lon, lat, h, tilt]) => Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(h, level + tilt) + area.offset + 0.8)),
              width: runCut ? 5 : 3,
              material: Cesium.Material.fromType('Color', { color: runCut ? CUT : WET_ROAD }),
            });
          }
          run = [];
        };
        for (let s = 0; s < road.samples.length; s++) {
          const sample = road.samples[s];
          const d = depthAtCell(sample.cell, level, onset);
          const isCut = d >= CUT_DEPTH_M;
          if (d >= 0.05) {
            if (run.length && isCut !== runCut) { const last = run.at(-1); flush(); run.push(last); }
            runCut = isCut;
            run.push([sample.lon, sample.lat, area.raw[sample.cell], area.raw[sample.cell] - area.heights[sample.cell]]);
            if (isCut) {
              cutM += sample.length;
              if (road.name) cutNames.set(road.name, (cutNames.get(road.name) ?? 0) + sample.length);
            }
          } else flush();
        }
        flush();
      }
      const facilities = osm.facilities.map((f) => ({ ...f, depth: depthAtCell(f.cell, level, onset) }));
      facilities.forEach((f, i) => {
        const entity = facilityEntities[i];
        if (!entity) return;
        const band = bandOf(f.depth);
        entity.point.color = band >= 0 ? C('#ff5a3c') : C('#9ef0c0');
        entity.label.text = `${FACILITY_LABELS[f.kind] ?? f.kind}${f.name ? ` · ${f.name}` : ''}${band >= 0 ? ` · ${f.depth.toFixed(1)} m` : ''}`;
      });
      Object.assign(stats, {
        buildings: { total: osm.buildings.length, wet, deep, byBand },
        roads: { cutKm: cutM / 1000, names: [...cutNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => name) },
        facilities: facilities.filter((f) => f.depth >= 0.05).sort((a, b) => b.depth - a.depth),
        facilitiesTotal: facilities.length,
      });
    }
    onStats(stats);
  }

  // ---------- data ----------

  async function loadOsm(lat, lon, id) {
    try {
      const response = await fetch(`/api/osm?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&radius=${OSM_RADIUS_M}`, { signal: AbortSignal.timeout(200_000) }); // the server may try three Overpass mirrors, then a smaller area
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (id !== buildId) return null;
      return data;
    } catch (error) {
      console.warn('OpenStreetMap data unavailable.', error);
      return null;
    }
  }

  function prepareOsm(data) {
    if (!data || !area) return null;
    const { grid, raw: heights } = area;
    // Depth at a building is read at the lowest ground beside it: in dense towns the terrain model
    // carries the buildings themselves, which would hide the water in the street.
    const beside = (cell) => (cell >= 0 ? lowestNear(area.heights, grid.n, cell) : -1);
    const buildings = (data.buildings ?? []).map(([lon, lat]) => ({ lon, lat, cell: beside(cellAt(grid, lon, lat)) })).filter((b) => b.cell >= 0);
    const roads = (data.roads ?? []).map((road) => {
      const samples = [];
      const coords = road.coords ?? [];
      for (let s = 1; s < coords.length; s++) {
        const a = coords[s - 1];
        const b = coords[s];
        const length = metres(a, b);
        const pieces = Math.max(1, Math.ceil(length / 12));
        for (let p = s === 1 ? 0 : 1; p <= pieces; p++) {
          const lon = a[0] + ((b[0] - a[0]) * p) / pieces;
          const lat = a[1] + ((b[1] - a[1]) * p) / pieces;
          const cell = cellAt(grid, lon, lat);
          if (cell >= 0) samples.push({ lon, lat, cell, length: length / pieces });
        }
      }
      return { name: road.name || '', kind: road.kind, samples };
    }).filter((road) => road.samples.length > 1);
    const facilities = (data.facilities ?? []).map((f) => ({ ...f, cell: beside(cellAt(grid, f.lon, f.lat)) })).filter((f) => f.cell >= 0).slice(0, 60);

    points.removeAll();
    const pointList = buildings.map((b) => points.add({
      position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat, heights[b.cell] + area.offset + 3),
      color: DRY_POINT, pixelSize: 4, disableDepthTestDistance: Number.POSITIVE_INFINITY,
    }));
    facilityEntities.forEach((entity) => viewer.entities.remove(entity));
    facilityEntities.length = 0;
    for (const f of facilities) {
      facilityEntities.push(viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, heights[f.cell] + area.offset + 6),
        point: { pixelSize: 11, color: C('#9ef0c0'), outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: FACILITY_LABELS[f.kind] ?? f.kind, font: '600 12px Poppins, system-ui, sans-serif', fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -16), verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2600),
          scaleByDistance: new Cesium.NearFarScalar(200, 1, 2600, 0.7),
        },
        show: layers.facilities,
      }));
    }
    return { buildings, roads, facilities, points: pointList, status: data.status, attribution: data.attribution, radius: data.radius, partial: Boolean(data.partial) };
  }

  // ---------- public API ----------

  function clear() {
    buildId++;
    clearTimeout(pendingTimer);
    area = null;
    current = null;
    builtKey = '';
    removePrims();
    points.removeAll();
    roadLines.removeAll();
    facilityEntities.forEach((entity) => viewer.entities.remove(entity));
    facilityEntities.length = 0;
  }

  /** Sample the terrain around `pin` ({lon, lat, height} radians/metres) and get the area ready. */
  async function build(pin) {
    clear();
    const id = buildId;
    const lon = Cesium.Math.toDegrees(pin.lon);
    const lat = Cesium.Math.toDegrees(pin.lat);
    const grid = gridPoints(lon, lat, AREA_SIZE_M, AREA_CELLS);
    const osmPromise = loadOsm(lat, lon, id);
    const cartos = grid.points.map((p) => Cesium.Cartographic.fromDegrees(p.lon, p.lat));
    const pinCarto = Cesium.Cartographic.fromRadians(pin.lon, pin.lat);
    const chunk = 1800;
    for (let start = 0; start < cartos.length; start += chunk) {
      onStatus(`Reading the terrain… ${Math.round((start / cartos.length) * 100)}%`);
      await sampleHeights(cartos.slice(start, start + chunk));
      if (id !== buildId) return null;
    }
    await sampleHeights([pinCarto]);
    if (id !== buildId) return null;
    const raw = Float64Array.from(cartos, (c) => (Number.isFinite(c.height) ? c.height : NaN));
    const known = raw.filter(Number.isFinite).length;
    if (known < raw.length * 0.5) throw new Error('not enough terrain data here');
    const patched = medianFilter(patchHeights(raw, grid.n), grid.n);
    // Flood maths runs on detrended heights (the valley's regional slope removed), so one water level
    // stands for a surface that slopes with the valley instead of a flat lake drowning everything downhill.
    // Open water (sea, lagoon) is already water: leave it out, so rain and surge flood the land around it.
    const water = openWaterMask(patched);
    const land = water ? Float64Array.from(patched, (h, k) => (water[k] ? NaN : h)) : patched;
    const plane = fitPlane(land, grid.n, grid.cellM);
    const heights = detrend(patched, grid.n, grid.cellM, plane);
    if (water) water.forEach((w, k) => { if (w) heights[k] = Infinity; });
    const pinCell = cellAt(grid, lon, lat);
    const pinTilt = Number.isFinite(heights[pinCell]) ? patched[pinCell] - heights[pinCell] : 0;
    // Street level in the terrain model: the pin's own sample can sit on a building bump (4 m in Paiporta),
    // which would make "1 m at your spot" drown everything 4 m lower. Use the low ground around it instead.
    // Both models use the WGS84 ellipsoid, so the 3D city's street height is the best street level,
    // unless it disagrees wildly with the terrain (then trust the terrain's low ground).
    const around = localGround(patched, grid.n, pinCell);
    const terrainPinRaw = Number.isFinite(pin.height) && Math.abs(pin.height - around) <= 8 ? pin.height
      : Math.min(Number.isFinite(pinCarto.height) ? pinCarto.height : Infinity, around);
    const terrainPin = terrainPinRaw - pinTilt;
    const sources = lowestCells(heights);
    area = {
      grid, heights, raw: patched, plane, pinCell, terrainPin, sources,
      offset: pin.height - terrainPinRaw,
      onsetRain: floodOnset(heights, grid.n, sources),
      onsetLevel: floodOnset(heights, grid.n, [...sources, pinCell]),
      osm: null,
    };
    area.lattice = lattice();
    onStatus('Loading buildings, roads and facilities from OpenStreetMap…');
    const osm = await osmPromise;
    if (id !== buildId) return null;
    area.osm = prepareOsm(osm);
    onStatus(area.osm ? '' : 'OpenStreetMap is busy, so buildings and roads are not counted. The flood itself still works.');
    if (current) rebuild();
    return area;
  }

  /** Show the flood for a water depth at your spot (level scenarios: manual, river, surge). */
  function showDepth(depth) {
    if (!area) return;
    // Dry at your spot means no flood at all (otherwise everything lower than your street would show as water).
    show(depth < 0.005 ? -Infinity : area.terrainPin + depth, area.onsetLevel);
  }

  /** Show the flood for a volume of rain runoff (m³) collecting in the low ground. Returns the depth at your spot. */
  function showVolume(volume) {
    if (!area) return 0;
    const level = levelForVolume(area.heights, area.onsetRain, volume, area.grid.cellM ** 2);
    if (!Number.isFinite(level)) return 0;
    show(level, area.onsetRain);
    return area.onsetRain[area.pinCell] < level ? Math.max(0, level - area.terrainPin) : 0;
  }

  /** Depth at your spot for a runoff volume, without drawing anything (for the timeline curve). */
  function depthForVolume(volume) {
    if (!area) return null;
    const level = levelForVolume(area.heights, area.onsetRain, volume, area.grid.cellM ** 2);
    if (!Number.isFinite(level)) return 0;
    return area.onsetRain[area.pinCell] < level ? Math.max(0, level - area.terrainPin) : 0;
  }

  function show(level, onset) {
    current = { level, onset };
    // The surface rides on the level every frame; the expensive parts rebuild a few times a second.
    if (Number.isFinite(level)) {
      if (waterPrim) waterPrim.modelMatrix = frameAt(level);
      if (depthPrim) depthPrim.modelMatrix = frameAt(level + 0.05);
    }
    const wait = REBUILD_MS - (performance.now() - lastBuild);
    clearTimeout(pendingTimer);
    if (wait <= 0) rebuild();
    else pendingTimer = setTimeout(rebuild, wait);
  }

  function setLayer(name, value) {
    layers[name] = value;
    showLayers();
  }

  return {
    build, clear, showDepth, showVolume, depthForVolume, setLayer, layers,
    get ready() { return Boolean(area); },
    get debug() {
      if (!area) return null;
      const pct = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
      const { n } = area.grid;
      const row = (j) => [...area.raw.slice(j * n, j * n + n)].filter((_, i) => i % 15 === 0).map((v) => v.toFixed(1)).join(' ');
      return { plane: area.plane, rawP: [0, 0.1, 0.5, 0.9, 1].map((p) => pct(area.raw, p).toFixed(1)), flatP: [0, 0.1, 0.5, 0.9, 1].map((p) => pct(area.heights, p).toFixed(1)), terrainPin: area.terrainPin, pinCell: area.pinCell, rows: [0, 22, 45, 67, 89].map(row) };
    },
    get info() { return area && { cellM: area.grid.cellM, sizeM: area.grid.sizeM, terrainPin: area.terrainPin, offset: area.offset, osm: area.osm && { buildings: area.osm.buildings.length, roads: area.osm.roads.length, facilities: area.osm.facilities.length, status: area.osm.status, radius: area.osm.radius, partial: area.osm.partial } }; },
    /** Catchment for local rain: the whole simulated square. */
    get areaM2() { return AREA_SIZE_M * AREA_SIZE_M; },
  };
}
