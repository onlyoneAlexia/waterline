import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTileExtents, findTile, tileUrl, JRC_BASE_URL } from '../lib/flood-depth.mjs';

const geojson = {
  features: [
    { properties: { id: 37, name: 'N40_W100' }, geometry: { coordinates: [[[-100.007, 40.004], [-90.008, 40.004], [-90.008, 30.005], [-100.007, 30.005], [-100.007, 40.004]]] } },
    { properties: { id: 45, name: 'N40_W90' }, geometry: { coordinates: [[[-90.008, 40.004], [-80.009, 40.004], [-80.009, 30.005], [-90.008, 30.005], [-90.008, 40.004]]] } },
  ],
};

test('finds the tile containing a point', () => {
  const tiles = parseTileExtents(geojson);
  assert.equal(findTile(tiles, -99.1365, 30.0445).name, 'N40_W100'); // Kerrville, TX
  assert.equal(findTile(tiles, -82.568, 35.586).name, 'N40_W90'); // Asheville, NC
  assert.equal(findTile(tiles, 5.05, 9.29), null); // not in this small index
});

test('builds JRC depth file URLs', () => {
  assert.equal(
    tileUrl({ id: 37, name: 'N40_W100' }, 100),
    `${JRC_BASE_URL}/RP100/ID37_N40_W100_RP100_depth.tif`,
  );
});
