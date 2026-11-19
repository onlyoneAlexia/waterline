// Waterline flood simulation. Pure functions with no Cesium, so the same code runs in Node tests.
//
// The model is a "connected bathtub" on a bare-earth terrain grid: water enters at source cells
// (the lowest ground, which is the river channel or the shore, plus your spot) and spreads to every
// cell it can reach without climbing above the water level. Walls, drains and flow speed are not
// modelled. A water level can come straight from a scenario (river or surge), or from a volume of
// rain runoff that fills the low ground (rain scenarios).

const R = 6_378_137;

/** Depth bands for the map legend and the impact counts (metres). */
export const BANDS = [
  { min: 0.05, label: 'Ankle', color: '#bfe9ff' },
  { min: 0.3, label: 'Knee, cars float', color: '#6cc4f5' },
  { min: 0.6, label: 'Waist, vehicles swept', color: '#2f8fe0' },
  { min: 1.2, label: 'Chest, ground floor', color: '#2350c4' },
  { min: 2.0, label: 'Over head height', color: '#3a1f9e' },
];

export function bandOf(depth) {
  let band = -1;
  for (let i = 0; i < BANDS.length; i++) if (depth >= BANDS[i].min) band = i;
  return band;
}

/**
 * Sample points for an n×n grid centred on a point, row-major from the south-west corner.
 * Returns degrees, so callers can hand them to any height sampler.
 */
export function gridPoints(lonDeg, latDeg, sizeM, n) {
  const cellM = sizeM / n;
  const half = sizeM / 2 - cellM / 2;
  const cosLat = Math.cos((latDeg * Math.PI) / 180);
  const points = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const east = -half + i * cellM;
      const north = -half + j * cellM;
      points.push({ lon: lonDeg + ((east / (R * cosLat)) * 180) / Math.PI, lat: latDeg + ((north / R) * 180) / Math.PI });
    }
  }
  return { n, sizeM, cellM, lon: lonDeg, lat: latDeg, points };
}

/** Index of the grid cell containing a point, or -1 outside the grid. */
export function cellAt(grid, lonDeg, latDeg) {
  const cosLat = Math.cos((grid.lat * Math.PI) / 180);
  const east = ((lonDeg - grid.lon) * Math.PI / 180) * R * cosLat;
  const north = ((latDeg - grid.lat) * Math.PI / 180) * R;
  const i = Math.floor((east + grid.sizeM / 2) / grid.cellM);
  const j = Math.floor((north + grid.sizeM / 2) / grid.cellM);
  if (i < 0 || j < 0 || i >= grid.n || j >= grid.n) return -1;
  return j * grid.n + i;
}

/** Fill gaps (NaN heights) with the mean of known neighbours so one missing tile can't wall off a valley. */
export function patchHeights(heights, n) {
  const out = Float64Array.from(heights);
  for (let pass = 0; pass < 4; pass++) {
    let missing = 0;
    for (let k = 0; k < out.length; k++) {
      if (Number.isFinite(out[k])) continue;
      const x = k % n;
      const y = (k - x) / n;
      let sum = 0;
      let count = 0;
      for (const [dx, dy] of N4) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const h = out[yy * n + xx];
        if (Number.isFinite(h)) { sum += h; count++; }
      }
      if (count) out[k] = sum / count; else missing++;
    }
    if (!missing) break;
  }
  return out;
}

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 3×3 median filter: removes single-cell spikes (a building baked into the terrain model) but keeps banks and valleys. */
export function medianFilter(heights, n) {
  const out = new Float64Array(heights.length);
  const window = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      window.length = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
          const h = heights[yy * n + xx];
          if (Number.isFinite(h)) window.push(h);
        }
      }
      window.sort((a, b) => a - b);
      out[y * n + x] = window.length ? window[window.length >> 1] : heights[y * n + x];
    }
  }
  return out;
}

/**
 * Open water (sea, lagoon, a wide river) shows up in a terrain model as a large flat plateau at the
 * lowest height. Returns a mask of those cells, or null when there is no such plateau (≥ minShare).
 * Floodwater does not "fill" the sea: those cells are left out of the flood maths and drawing.
 */
export function openWaterMask(heights, { tolerance = 0.6, minShare = 0.03 } = {}) {
  let min = Infinity;
  for (const h of heights) if (Number.isFinite(h) && h < min) min = h;
  if (!Number.isFinite(min)) return null;
  const mask = new Uint8Array(heights.length);
  let count = 0;
  for (let k = 0; k < heights.length; k++) if (heights[k] - min < tolerance) { mask[k] = 1; count++; }
  return count >= heights.length * minShare ? mask : null;
}

/** Index of the lowest cell within `radius` cells: the ground beside a building rather than its roof bump. */
export function lowestNear(heights, n, cell, radius = 1) {
  const x0 = cell % n;
  const y0 = (cell - x0) / n;
  let best = cell;
  for (let y = Math.max(0, y0 - radius); y <= Math.min(n - 1, y0 + radius); y++) {
    for (let x = Math.max(0, x0 - radius); x <= Math.min(n - 1, x0 + radius); x++) {
      const k = y * n + x;
      if (Number.isFinite(heights[k]) && !(heights[k] >= heights[best])) best = k;
    }
  }
  return best;
}

/** Ground level near a cell: a low percentile of the cells within `radius` cells (streets sit low among buildings). */
export function localGround(heights, n, cell, radius = 2, share = 0.25) {
  const x0 = cell % n;
  const y0 = (cell - x0) / n;
  const values = [];
  for (let y = Math.max(0, y0 - radius); y <= Math.min(n - 1, y0 + radius); y++) {
    for (let x = Math.max(0, x0 - radius); x <= Math.min(n - 1, x0 + radius); x++) {
      const h = heights[y * n + x];
      if (Number.isFinite(h)) values.push(h);
    }
  }
  values.sort((a, b) => a - b);
  return values.length ? values[Math.floor(share * (values.length - 1))] : heights[cell];
}

// Small binary heap keyed by level, for the priority flood.
class MinHeap {
  constructor() { this.keys = []; this.vals = []; }
  get size() { return this.keys.length; }
  push(val, key) {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(key); vals.push(val);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent]; vals[i] = vals[parent];
      i = parent;
    }
    keys[i] = key; vals[i] = val;
  }
  pop() {
    const { keys, vals } = this;
    const topKey = keys[0];
    const topVal = vals[0];
    const lastKey = keys.pop();
    const lastVal = vals.pop();
    if (keys.length) {
      let i = 0;
      const n = keys.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        keys[i] = keys[c]; vals[i] = vals[c];
        i = c;
      }
      keys[i] = lastKey; vals[i] = lastVal;
    }
    return [topVal, topKey];
  }
}

/**
 * For every cell, the lowest water level at which the flood spreading from `sources` reaches it
 * (the "minimax" path height: the highest ground the water must cross on its easiest way there).
 * A cell is under water at level L exactly when onset < L, and its depth is L - height.
 */
export function floodOnset(heights, n, sources) {
  const onset = new Float64Array(n * n).fill(Infinity);
  const heap = new MinHeap();
  for (const s of sources) {
    const h = heights[s];
    if (s < 0 || s >= onset.length || !Number.isFinite(h) || h >= onset[s]) continue;
    onset[s] = h;
    heap.push(s, h);
  }
  while (heap.size) {
    const [cell, level] = heap.pop();
    if (level > onset[cell]) continue;
    const x = cell % n;
    const y = (cell - x) / n;
    for (const [dx, dy] of N4) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const k = yy * n + xx;
      const h = heights[k];
      if (!Number.isFinite(h)) continue;
      const reach = Math.max(level, h);
      if (reach < onset[k]) {
        onset[k] = reach;
        heap.push(k, reach);
      }
    }
  }
  return onset;
}

/**
 * The valley floor's regional slope, as a plane z = p0 + a·east + b·north (metres from the grid centre).
 * Fitted to all cells first, then twice more to the cells at or below the plane, so hills don't tilt it.
 * A flood's water surface slopes with its valley; subtracting this plane lets one water level stand
 * for a sloping surface (a "relative elevation model"). The slope is capped at 2%.
 */
export function fitPlane(heights, n, cellM, maxSlope = 0.02) {
  const half = (n * cellM) / 2;
  const xs = (k) => ((k % n) + 0.5) * cellM - half;
  const ys = (k) => (Math.floor(k / n) + 0.5) * cellM - half;
  let plane = null;
  for (let iter = 0; iter < 3; iter++) {
    let s1 = 0; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let syy = 0; let sz = 0; let sxz = 0; let syz = 0;
    for (let k = 0; k < heights.length; k++) {
      const z = heights[k];
      if (!Number.isFinite(z)) continue;
      const x = xs(k);
      const y = ys(k);
      if (plane && z > plane.p0 + plane.a * x + plane.b * y + 0.25) continue;
      s1++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; sz += z; sxz += x * z; syz += y * z;
    }
    if (s1 < 10) break;
    // Solve the 3×3 normal equations by Cramer's rule.
    const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    const A = [s1, sx, sy, sx, sxx, sxy, sy, sxy, syy];
    const D = det(A);
    if (!Number.isFinite(D) || Math.abs(D) < 1e-9) break;
    const p0 = det([sz, sx, sy, sxz, sxx, sxy, syz, sxy, syy]) / D;
    const a = det([s1, sz, sy, sx, sxz, sxy, sy, syz, syy]) / D;
    const b = det([s1, sx, sz, sx, sxx, sxz, sy, sxy, syz]) / D;
    plane = { p0, a, b };
  }
  if (!plane) return { p0: 0, a: 0, b: 0 };
  const clamp = (v) => Math.max(-maxSlope, Math.min(maxSlope, v));
  return { p0: plane.p0, a: clamp(plane.a), b: clamp(plane.b) };
}

/** Heights with the regional slope removed (the plane's tilt only, so values stay in metres near the real ones). */
export function detrend(heights, n, cellM, plane) {
  const half = (n * cellM) / 2;
  return Float64Array.from(heights, (z, k) => z - (plane.a * (((k % n) + 0.5) * cellM - half) + plane.b * ((Math.floor(k / n) + 0.5) * cellM - half)));
}

/** The lowest cells: where a river channel or the shore usually is. At least `min` cells. */
export function lowestCells(heights, share = 0.004, min = 3) {
  const order = [...heights.keys()].filter((k) => Number.isFinite(heights[k])).sort((a, b) => heights[a] - heights[b]);
  return order.slice(0, Math.max(min, Math.round(order.length * share)));
}

/** Water depth per cell at `level` (0 where dry). */
export function depthsAt(heights, onset, level) {
  const out = new Float32Array(heights.length);
  for (let k = 0; k < heights.length; k++) if (onset[k] < level) out[k] = level - heights[k];
  return out;
}

/** Volume of water (m³) standing on the grid at `level`. */
export function volumeAt(heights, onset, level, cellArea) {
  let sum = 0;
  for (let k = 0; k < heights.length; k++) if (onset[k] < level) sum += level - heights[k];
  return sum * cellArea;
}

/** The water level that holds `volume` m³ (binary search; the volume grows with the level). */
export function levelForVolume(heights, onset, volume, cellArea) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < heights.length; k++) {
    if (!Number.isFinite(onset[k])) continue;
    lo = Math.min(lo, onset[k]);
    hi = Math.max(hi, heights[k]);
  }
  if (!Number.isFinite(lo)) return NaN;
  if (!(volume > 0)) return lo;
  hi += 50; // enough headroom for any volume this model is asked about
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (volumeAt(heights, onset, mid, cellArea) < volume) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Flooded area (m²) and cells per depth band at `level`. */
export function floodStats(heights, onset, level, cellArea) {
  const bands = BANDS.map(() => 0);
  let wet = 0;
  let maxDepth = 0;
  for (let k = 0; k < heights.length; k++) {
    if (!(onset[k] < level)) continue;
    const d = level - heights[k];
    if (d < BANDS[0].min) continue;
    wet++;
    maxDepth = Math.max(maxDepth, d);
    bands[bandOf(d)]++;
  }
  return { areaM2: wet * cellArea, bands: bands.map((c) => c * cellArea), maxDepth };
}

// ---------- scenario time series ----------

/**
 * Runoff stored on the ground after each hour of rain (m³): rain beyond what the drains carry,
 * times a runoff share, over the catchment, leaking away at `outflowPerH` (a linear reservoir).
 */
export function rainStorage(rainMm, { areaM2, drainMmPerH = 10, runoff = 0.7, outflowPerH = 0.06 } = {}) {
  let stored = 0;
  return rainMm.map((mm) => {
    const excess = Math.max(0, (Number(mm) || 0) * runoff - drainMmPerH);
    stored = stored * (1 - outflowPerH) + (excess / 1000) * areaM2;
    return stored;
  });
}

/** A rise-and-fall shape (0..1) from hourly rain: the river or ravine responds to rain with a lag. */
export function responseShape(rainMm, { lagH = 2, outflowPerH = 0.12 } = {}) {
  let stored = 0;
  const raw = rainMm.map((mm) => { stored = stored * (1 - outflowPerH) + Math.max(0, Number(mm) || 0); return stored; });
  const lagged = raw.map((_, i) => raw[Math.max(0, i - lagH)] * (i >= lagH ? 1 : i / Math.max(lagH, 1)));
  const peak = Math.max(...lagged, 0);
  return peak > 0 ? lagged.map((v) => v / peak) : lagged.map(() => 0);
}

/** Normalise any series (river discharge, sea level) to 0..1 between its minimum and maximum. */
export function normalise(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return values.map(() => 0);
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  return values.map((v) => (Number.isFinite(v) && hi > lo ? (v - lo) / (hi - lo) : 0));
}

/** A synthetic storm: `totalMm` of rain over `hours`, peaking a third of the way through. */
export function designStorm(totalMm, hours, length = Math.max(hours + 18, 24)) {
  const peakAt = Math.max(1, Math.round(hours / 3));
  const weights = Array.from({ length }, (_, i) => {
    if (i >= hours) return 0;
    return i <= peakAt ? (i + 1) / (peakAt + 1) : Math.max(0.05, (hours - i) / (hours - peakAt));
  });
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => (w * totalMm) / sum);
}

/** A storm-surge shape over `length` hours: tide plus a surge bulge peaking at `peakAt`. */
export function surgeShape(length = 36, peakAt = 18) {
  const raw = Array.from({ length }, (_, i) => {
    const tide = 0.25 * (1 + Math.cos(((i - peakAt) / 12.42) * 2 * Math.PI));
    const surge = Math.exp(-(((i - peakAt) / 6) ** 2));
    return 0.6 * surge + 0.4 * surge * tide * 2;
  });
  return normalise(raw);
}

/** A river hydrograph shape for a design flood (rises over ~10 h, falls over ~30 h). */
export function riverShape(length = 48, peakAt = 14) {
  return Array.from({ length }, (_, i) => (i <= peakAt
    ? (1 - Math.cos((i / peakAt) * Math.PI)) / 2
    : Math.exp(-((i - peakAt) / 14))));
}

/** Linear interpolation into an hourly series at fractional hour `t`. */
export function sampleSeries(series, t) {
  if (!series.length) return 0;
  const i = Math.max(0, Math.min(series.length - 1, t));
  const a = Math.floor(i);
  const b = Math.min(series.length - 1, a + 1);
  return series[a] + (series[b] - series[a]) * (i - a);
}
