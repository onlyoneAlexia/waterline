// Modelled river-flood water depth at a point, from the JRC / Copernicus EMS
// "Global river flood hazard maps" v2.1 (GloFAS): 3 arc-second (~90 m) depth
// grids for 10- to 500-year floods. Licence: CC BY 4.0, (c) European Union.
//
// Tiles are 10x10 degree GeoTIFFs. The JRC server supports HTTP range requests,
// so geotiff.js reads only the header and the block holding our pixel.

import { fromUrl } from 'geotiff';

export const JRC_BASE_URL = 'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/CEMS-GLOFAS/flood_hazard';
export const RETURN_PERIODS = [10, 20, 50, 100, 200, 500];
const NEIGHBOUR_CELLS = 2;
export const ATTRIBUTION = 'River flood depths: JRC / Copernicus Emergency Management Service, Global river flood hazard maps v2.1 (CC BY 4.0)';

/** Parse tile_extents.geojson into simple bounding boxes. */
export function parseTileExtents(geojson) {
  return (geojson?.features ?? []).map((feature) => {
    const ring = feature.geometry?.coordinates?.[0] ?? [];
    const lons = ring.map((c) => c[0]);
    const lats = ring.map((c) => c[1]);
    return {
      id: feature.properties.id,
      name: feature.properties.name,
      west: Math.min(...lons),
      east: Math.max(...lons),
      south: Math.min(...lats),
      north: Math.max(...lats),
    };
  });
}

export function findTile(tiles, lon, lat) {
  return tiles.find((t) => lon >= t.west && lon < t.east && lat > t.south && lat <= t.north) ?? null;
}

export function tileUrl(tile, returnPeriod, baseUrl = JRC_BASE_URL) {
  return `${baseUrl}/RP${returnPeriod}/ID${tile.id}_${tile.name}_RP${returnPeriod}_depth.tif`;
}

export function createFloodDepthService({ baseUrl = JRC_BASE_URL, fetchImpl = fetch } = {}) {
  let tilesPromise = null;
  const images = new Map(); // url -> Promise<GeoTIFFImage>

  function loadTiles() {
    tilesPromise ??= (async () => {
      const response = await fetchImpl(`${baseUrl}/tile_extents.geojson`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Could not load JRC tile index (HTTP ${response.status})`);
      return parseTileExtents(await response.json());
    })().catch((error) => {
      tilesPromise = null;
      throw error;
    });
    return tilesPromise;
  }

  function loadImage(url) {
    if (!images.has(url)) {
      images.set(url, fromUrl(url, { allowFullFile: false }).then((tiff) => tiff.getImage()).catch((error) => {
        images.delete(url);
        throw error;
      }));
    }
    return images.get(url);
  }

  const clean = (value, noData) => {
    const v = Number(value);
    if (!Number.isFinite(v) || v === noData || v <= 0 || v > 1000) return 0;
    return Math.round(v * 100) / 100;
  };

  // Depth in the ~90 m cell under the point, plus the deepest cell within
  // NEIGHBOUR_CELLS cells (~180 m), because a coarse grid can miss a street by one cell.
  async function readCell(url, lon, lat) {
    const image = await loadImage(url);
    const [originX, originY] = image.getOrigin();
    const [resX, resY] = image.getResolution();
    const x = Math.floor((lon - originX) / resX);
    const y = Math.floor((lat - originY) / resY);
    const width = image.getWidth();
    const height = image.getHeight();
    if (x < 0 || y < 0 || x >= width || y >= height) return { here: 0, nearby: 0 };
    const x0 = Math.max(0, x - NEIGHBOUR_CELLS);
    const y0 = Math.max(0, y - NEIGHBOUR_CELLS);
    const x1 = Math.min(width, x + NEIGHBOUR_CELLS + 1);
    const y1 = Math.min(height, y + NEIGHBOUR_CELLS + 1);
    const [band] = await image.readRasters({ window: [x0, y0, x1, y1] });
    const noData = image.getGDALNoData();
    const here = clean(band[(y - y0) * (x1 - x0) + (x - x0)], noData);
    let nearby = here;
    for (const value of band) nearby = Math.max(nearby, clean(value, noData));
    return { here, nearby };
  }

  /**
   * Depths in metres for each return period, at the point and nearby.
   * All zeros means no modelled river flooding here (the model has no flash or coastal floods).
   */
  async function depthsAt(lon, lat) {
    const tiles = await loadTiles();
    const tile = findTile(tiles, lon, lat);
    const empty = Object.fromEntries(RETURN_PERIODS.map((rp) => [rp, { here: 0, nearby: 0 }]));
    if (!tile) return { covered: false, depths: empty, attribution: ATTRIBUTION };
    const cells = await Promise.all(RETURN_PERIODS.map((rp) => readCell(tileUrl(tile, rp, baseUrl), lon, lat)));
    const depths = Object.fromEntries(RETURN_PERIODS.map((rp, i) => [rp, cells[i]]));
    return { covered: true, tile: tile.name, depths, attribution: ATTRIBUTION };
  }

  return { depthsAt };
}
