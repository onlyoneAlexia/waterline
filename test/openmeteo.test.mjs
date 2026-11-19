import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchForecastDirect, fetchEventDirect, withDirectFallback } from '../public/openmeteo.js';

const hourly = { time: ['2026-11-19T00:00', '2026-11-19T01:00'], precipitation: [0.4, 2.1], wind_speed_10m: [10, 12], wind_gusts_10m: [20, 25], weather_code: [61, 63] };

function fakeOpenMeteo({ forecast = 200, river = 200, sea = 400 } = {}) {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    const json = (status, body) => new Response(JSON.stringify(body), { status });
    if (url.startsWith('https://api.open-meteo.com/') || url.startsWith('https://archive-api.open-meteo.com/')) {
      return forecast === 200
        ? json(200, { timezone: 'America/Chicago', elevation: 14, hourly })
        : json(forecast, { error: true, reason: 'Daily API request limit exceeded.' });
    }
    if (url.startsWith('https://flood-api.open-meteo.com/')) {
      return json(river, river === 200 ? { latitude: 29.75, longitude: -95.35, daily: { time: ['2026-11-19'], river_discharge: [41.5] } } : { error: true });
    }
    return json(sea, { error: true, reason: 'No data' });
  };
  return { fetchImpl, seen };
}

test('direct forecast has the server body shape, with river and an inland (null) sea', async () => {
  const { fetchImpl, seen } = fakeOpenMeteo();
  const body = await fetchForecastDirect('29.76000', '-95.37000', { fetchImpl });
  assert.equal(body.status, 'live');
  assert.equal(body.place.timezone, 'America/Chicago');
  assert.deepEqual(body.hourly.precipitation, [0.4, 2.1]);
  assert.equal(body.river.daily.river_discharge[0], 41.5);
  assert.equal(body.sea, null);
  assert.equal(body.sources.sea, 'unavailable');
  assert.match(body.attribution, /Open-Meteo/);
  assert.equal(seen.length, 3);
});

test('direct forecast fails when the forecast itself is refused', async () => {
  const { fetchImpl } = fakeOpenMeteo({ forecast: 429 });
  await assert.rejects(fetchForecastDirect(1, 2, { fetchImpl }), /HTTP 429: Daily API request limit/);
});

test('direct event reads the archive and keeps the dates', async () => {
  const { fetchImpl, seen } = fakeOpenMeteo();
  const body = await fetchEventDirect(39.42, -0.42, '2024-10-28', '2024-10-31', { fetchImpl });
  assert.deepEqual(body.event, { start: '2024-10-28', end: '2024-10-31' });
  assert.ok(seen[0].startsWith('https://archive-api.open-meteo.com/v1/archive?latitude=39.42&longitude=-0.42&start_date=2024-10-28'));
  assert.equal(body.sources.sea, undefined);
});

test('fallback: a working server answer is used as is, without asking Open-Meteo', async () => {
  let direct = 0;
  const out = await withDirectFallback(async () => ({ ok: true, data: { status: 'cached' } }), async () => { direct += 1; });
  assert.deepEqual(out, { status: 'cached' });
  assert.equal(direct, 0);
});

test('fallback: a server error (out of Open-Meteo requests) goes to Open-Meteo directly', async () => {
  const out = await withDirectFallback(
    async () => ({ ok: false, data: { error: 'forecast answered HTTP 429' } }),
    async () => ({ status: 'live', direct: true }),
  );
  assert.deepEqual(out, { status: 'live', direct: true });
});

test('fallback: live direct data beats the server\'s saved demo copy', async () => {
  const out = await withDirectFallback(async () => ({ ok: true, data: { status: 'fixture' } }), async () => ({ status: 'live' }));
  assert.equal(out.status, 'live');
});

test('fallback: when Open-Meteo also fails, the saved copy is kept', async () => {
  const out = await withDirectFallback(async () => ({ ok: true, data: { status: 'fixture' } }), async () => { throw new Error('offline'); });
  assert.equal(out.status, 'fixture');
});

test('fallback: when both fail, the server\'s error is reported', async () => {
  await assert.rejects(
    withDirectFallback(async () => ({ ok: false, data: { error: 'Weather data is unavailable right now' } }), async () => { throw new Error('offline'); }),
    /Weather data is unavailable right now/,
  );
});
