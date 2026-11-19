// Waterline scenarios: turn weather data or a "what if" into an hourly series the timeline plays.
// Each scenario is either
//   kind 'level'  -> values are water depths at your spot (river, surge, storm replay), or
//   kind 'volume' -> values are rain runoff volumes (m³) that fill the low ground (live forecast, heavy rain).
import { rainStorage, responseShape, designStorm, surgeShape, riverShape } from './sim.js';

const HOUR = 3_600_000;

function hoursFrom(start, length) {
  const first = new Date(start);
  first.setMinutes(0, 0, 0);
  return Array.from({ length }, (_, i) => new Date(first.getTime() + i * HOUR));
}

/** Parse Open-Meteo local ISO times ("2026-11-19T14:00") as wall-clock times in the place's zone. */
function parseTimes(times) {
  return (times ?? []).map((t) => new Date(`${t}${/Z|[+-]\d\d:?\d\d$/.test(t) ? '' : 'Z'}`));
}

export function forecastScenario(weather, areaM2) {
  const rain = (weather?.hourly?.precipitation ?? []).map((v) => (Number.isFinite(v) ? v : 0));
  if (!rain.length) return null;
  const total = rain.reduce((a, b) => a + b, 0);
  const peak = Math.max(...rain);
  return {
    id: 'forecast',
    title: 'Live forecast',
    kind: 'volume',
    hours: parseTimes(weather.hourly.time),
    utcLabels: false,
    rain,
    values: rainStorage(rain, { areaM2 }),
    note: `${total.toFixed(0)} mm of rain from yesterday to 3 days ahead, up to ${peak.toFixed(1)} mm in one hour. `
      + 'Rain beyond what the drains carry (about 10 mm an hour) collects in the low ground.',
    source: 'Live forecast · Open-Meteo rain, local runoff model',
  };
}

export function eventScenario(event, scene) {
  const rain = (event?.hourly?.precipitation ?? []).map((v) => (Number.isFinite(v) ? v : 0));
  if (!rain.length) return null;
  const shape = responseShape(rain, { lagH: scene.event.lagH ?? 2, outflowPerH: scene.event.outflowPerH ?? 0.1 });
  const total = rain.reduce((a, b) => a + b, 0);
  return {
    id: 'event',
    title: `Replay · ${scene.event.title}`,
    kind: 'level',
    hours: parseTimes(event.hourly.time),
    rain,
    values: shape.map((s) => s * scene.depth),
    note: `${total.toFixed(0)} mm of rain fell here in the reanalysis record. Local gauges measured far more: `
      + `${scene.event.gauge}. The water at your spot follows the storm and peaks at the reported ${scene.depth} m.`,
    source: 'Storm replay · ERA5 rainfall (Open-Meteo), depth scaled to the reported event',
  };
}

export function heavyRainScenario(totalMm, hours, areaM2) {
  const rain = designStorm(totalMm, hours);
  return {
    id: 'rain',
    title: `${totalMm} mm in ${hours} h`,
    kind: 'volume',
    relative: true,
    hours: hoursFrom(Date.now(),rain.length),
    rain,
    values: rainStorage(rain, { areaM2 }),
    note: `What if ${totalMm} mm of rain fell in ${hours} hours? Valencia’s storm dropped 771 mm in a day at Turís; `
      + 'Lagos often sees 100 mm or more in a few hours.',
    source: `What-if storm · ${totalMm} mm in ${hours} h, local runoff model`,
  };
}

export function riverScenario(peakDepth, label) {
  const shape = riverShape(48, 14);
  return {
    id: 'river',
    title: `River flood · ${label}`,
    kind: 'level',
    relative: true,
    hours: hoursFrom(Date.now(),shape.length),
    rain: shape.map(() => 0),
    values: shape.map((s) => s * peakDepth),
    note: `A river flood that rises over about 14 hours and peaks at ${peakDepth.toFixed(1)} m at your spot, from the JRC / Copernicus model.`,
    source: `River flood · JRC / Copernicus, ${label}`,
  };
}

export function surgeScenario(surgeM, sea) {
  const shape = surgeShape(36, 18);
  const tide = sea?.hourly?.sea_level_height_msl?.filter(Number.isFinite) ?? [];
  const range = tide.length ? Math.max(...tide) - Math.min(...tide) : 0;
  return {
    id: 'surge',
    title: `Storm surge · ${surgeM.toFixed(1)} m`,
    kind: 'level',
    relative: true,
    hours: hoursFrom(Date.now(),shape.length),
    rain: shape.map(() => 0),
    values: shape.map((s) => s * surgeM),
    note: `A storm surge that lifts the sea ${surgeM.toFixed(1)} m above your street at high tide.`
      + (range ? ` The forecast tide range here is ${range.toFixed(1)} m.` : ''),
    source: `Storm surge what-if · ${surgeM.toFixed(1)} m`,
  };
}

/** A clock label in the place's own time (Open-Meteo already gives local wall-clock times). */
export function hourLabel(date, withDay = false) {
  const opts = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' };
  if (withDay) Object.assign(opts, { weekday: 'short', day: 'numeric', month: 'short' });
  return new Intl.DateTimeFormat('en-GB', opts).format(date);
}
