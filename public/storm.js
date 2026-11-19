// Waterline storm desk: the weather card, the scenario picker, the timeline, the map layers and the
// area impact report. It drives the app through setDepth(), so the street water, your Lux3D objects,
// the facts and the room view all follow the simulated storm.
import { createTimeline } from './timeline.js';
import { forecastScenario, eventScenario, heavyRainScenario, riverScenario, surgeScenario } from './scenarios.js';
import { BANDS, sampleSeries } from './sim.js';
import { fetchForecastDirect, fetchEventDirect, withDirectFallback } from './openmeteo.js';

const YEARLY_CHANCE = { 10: '10% a year', 20: '5% a year', 50: '2% a year', 100: '1% a year', 200: '0.5% a year', 500: '0.2% a year' };

export function createStorm({ Cesium, state, setDepth, stopPlaying, toast, el, refreshImpact }) {
  const $ = (selector) => document.querySelector(selector);
  const timeline = createTimeline($('#timeline'), { onScrub: (t) => { pause(); seek(t); } });
  let pin = null;
  let weather = null;
  let eventData = null; // { scene, data }
  let jrc = null;
  let scenario = null;
  let choice = 'manual';
  let t = 0;
  let raf = 0;
  let playResolve = null;
  let areaReady = null;
  let placeName = '';
  const params = { rainMm: 150, rainH: 6, rp: null, peak: 1.2, surge: 2 };

  $('#legend-bar').replaceChildren(...BANDS.map((band) => { const span = el('span'); span.style.background = band.color; return span; }));

  // ---------- layers ----------
  document.querySelectorAll('[data-layer]').forEach((button) => {
    button.addEventListener('click', () => {
      const on = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(on));
      const name = button.dataset.layer;
      state.area?.setLayer(name, name === 'depth' ? (on ? 'on' : 'auto') : on);
    });
  });

  // ---------- weather card ----------
  const fmt = (value, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : '–');

  function nowIndex(times, timezone) {
    if (!times?.length) return -1;
    let key;
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date()).map((p) => [p.type, p.value]));
      key = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
    } catch { key = new Date().toISOString().slice(0, 13) + ':00'; }
    const exact = times.indexOf(key);
    if (exact >= 0) return exact;
    const later = times.findIndex((time) => time > key);
    return later > 0 ? later - 1 : times.length - 1;
  }

  function statusText(status) {
    return { live: 'Live', cached: 'Live (cached)', stale: 'Saved copy (service busy)', fixture: 'Saved demo copy (service unavailable)' }[status] ?? 'Unavailable';
  }

  function renderWeather() {
    const card = $('#wx-card');
    card.hidden = !pin || state.mode === 'studio'; // the studio street is not a real place
    $('#wx-place').textContent = placeName || 'Your spot';
    if (!weather) return;
    const tz = weather.place?.timezone;
    const hourly = weather.hourly ?? {};
    const i = nowIndex(hourly.time, tz);
    const rain = hourly.precipitation ?? [];
    const next24 = i >= 0 ? rain.slice(i, i + 24).reduce((a, b) => a + (Number(b) || 0), 0) : NaN;
    const gusts = i >= 0 ? Math.max(...(hourly.wind_gusts_10m ?? []).slice(i, i + 24).filter(Number.isFinite), 0) : NaN;
    $('#wx-rain').innerHTML = `${fmt(rain[i], 1)}<small> mm/h</small>`;
    $('#wx-rain24').innerHTML = `${fmt(next24, 0)}<small> mm</small>`;
    $('#wx-wind').innerHTML = `${fmt(gusts, 0)}<small> km/h</small>`;
    const river = weather.river?.daily;
    if (river?.river_discharge?.length) {
      const today = new Date().toISOString().slice(0, 10);
      let d = river.time.indexOf(today);
      if (d < 0) d = river.time.findIndex((x) => x > today) - 1;
      const q = river.river_discharge[d];
      const before = river.river_discharge[d - 1];
      const arrow = Number.isFinite(q) && Number.isFinite(before) ? (q > before * 1.05 ? ' ↑' : q < before * 0.95 ? ' ↓' : ' →') : '';
      $('#wx-river').innerHTML = Number.isFinite(q) ? `${q >= 100 ? q.toFixed(0) : q.toFixed(1)}<small> m³/s${arrow}</small>` : 'n/a';
    } else $('#wx-river').textContent = 'n/a';
    const sea = weather.sea?.hourly?.sea_level_height_msl;
    const seaNow = sea?.[nowIndex(weather.sea?.hourly?.time, tz)];
    $('#wx-sea').innerHTML = Number.isFinite(seaNow) ? `${seaNow >= 0 ? '+' : ''}${seaNow.toFixed(2)}<small> m</small>` : 'Inland';
    $('#wx-ground').innerHTML = Number.isFinite(weather.place?.elevation) ? `${weather.place.elevation.toFixed(0)}<small> m asl</small>` : '–';
    const status = $('#wx-status');
    status.dataset.status = weather.status ?? 'off';
    status.textContent = `${statusText(weather.status)} · Open-Meteo${weather.river ? ', GloFAS' : ''}${tz ? ` · ${tz}` : ''}`;
  }

  async function askServer(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    let data = null;
    try { data = await response.json(); } catch { /* not JSON */ }
    return { ok: response.ok, data };
  }

  async function loadWeather(forPin) {
    const lat = Cesium.Math.toDegrees(forPin.lat).toFixed(5);
    const lon = Cesium.Math.toDegrees(forPin.lon).toFixed(5);
    try {
      // Our server first; if it is out of Open-Meteo requests, the browser asks Open-Meteo itself.
      const data = await withDirectFallback(
        () => askServer(`/api/weather?lat=${lat}&lon=${lon}`),
        () => fetchForecastDirect(lat, lon),
      );
      if (pin !== forPin) return;
      weather = data;
    } catch (error) {
      if (pin !== forPin) return;
      weather = null;
      $('#wx-status').dataset.status = 'off';
      $('#wx-status').textContent = `Weather unavailable (${error.message}). Scenarios still work.`;
    }
    renderWeather();
    if (choice === 'forecast') choose('forecast', { autoplay: false });
  }

  async function loadJrc(forPin) {
    try {
      const lat = Cesium.Math.toDegrees(forPin.lat).toFixed(6);
      const lon = Cesium.Math.toDegrees(forPin.lon).toFixed(6);
      const response = await fetch(`/api/flood-depth?lat=${lat}&lon=${lon}`);
      const data = await response.json();
      if (pin === forPin && response.ok) jrc = data;
    } catch { /* The river model is optional. */ }
    if (pin === forPin && choice === 'river') renderParams();
  }

  // ---------- the area simulation ----------

  function areaStatus(text) { $('#area-status').textContent = text; }

  function buildArea(forPin) {
    if (!state.area) { areaReady = Promise.resolve(false); return; }
    areaStatus('Reading the terrain around your spot…');
    areaReady = state.area.build(forPin).then((area) => {
      if (!area || pin !== forPin) return false;
      const info = state.area.info;
      areaStatus(`Simulating ${(info.sizeM / 1000).toFixed(1)} × ${(info.sizeM / 1000).toFixed(1)} km at ${info.cellM.toFixed(0)} m`
        + (info.osm ? ` · ${info.osm.buildings.toLocaleString()} buildings, ${info.osm.facilities} services (OpenStreetMap${info.osm.partial ? `, nearest ${info.osm.radius} m: the full area is busy` : ''})` : ''));
      $('#layers').hidden = false;
      $('#legend').hidden = false;
      if (scenario) { rebuildSeries(); seek(t); } else setDepth(state.depth, state.depthSource);
      return true;
    }).catch((error) => {
      if (pin === forPin) areaStatus(`Area simulation unavailable here (${error.message}). The water still rises at your spot.`);
      return false;
    });
  }

  function onStats(stats) {
    state.areaStats = stats;
    const cards = [];
    const area = stats.areaM2 >= 1e5 ? `${(stats.areaM2 / 1e6).toFixed(2)} km²` : `${(stats.areaM2 / 1e4).toFixed(1)} ha`;
    cards.push(['Flooded area', area, stats.areaM2 > 0]);
    cards.push(['Deepest water', `${stats.maxDepth.toFixed(1)} m`, stats.maxDepth >= 1.2]);
    if (stats.buildings) {
      cards.push(['Buildings in water', `${stats.buildings.wet.toLocaleString()} / ${stats.buildings.total.toLocaleString()}`, stats.buildings.wet > 0]);
      cards.push(['Ground floors flooded', stats.buildings.deep.toLocaleString(), stats.buildings.deep > 0]);
      cards.push(['Roads cut (≥30 cm)', `${stats.roads.cutKm.toFixed(1)} km`, stats.roads.cutKm > 0]);
      cards.push(['Services in water', `${stats.facilities.length} / ${stats.facilitiesTotal}`, stats.facilities.length > 0]);
    }
    const make = ([label, value, alert]) => { const card = el('div', `stat${alert ? ' alert' : ''}`); card.append(el('b', '', value), el('span', '', label)); return card; };
    $('#area-stats').replaceChildren(...cards.map(make));
    $('#area-impact').replaceChildren(...cards.map(make));
    const roads = $('#cut-roads');
    roads.hidden = !stats.roads?.names.length;
    roads.replaceChildren(...(stats.roads?.names ?? []).map((name) => { const li = el('li'); li.append(el('span', '', name), el('span', '', 'cut')); return li; }));
    const services = $('#hit-facilities');
    services.hidden = !stats.facilities?.length;
    services.replaceChildren(...(stats.facilities ?? []).slice(0, 5).map((f) => {
      const li = el('li');
      const kind = f.kind.replace('_', ' ');
      li.append(el('span', '', f.name || kind[0].toUpperCase() + kind.slice(1)), el('b', '', `${f.depth.toFixed(1)} m`));
      return li;
    }));
    refreshImpact();
  }

  // ---------- scenarios ----------

  function approxDepth(volume) {
    // Without terrain: spread the runoff over the lowest ~15% of the square. Labelled as approximate.
    return Math.min(3, volume / ((state.area?.areaM2 ?? 3.24e6) * 0.15));
  }

  function rebuildSeries() {
    if (!scenario) return;
    const depth = scenario.kind === 'volume'
      ? scenario.values.map((v) => (state.area?.ready ? state.area.depthForVolume(v) : approxDepth(v)))
      : scenario.values;
    scenario.depth = depth;
    timeline.set({ hours: scenario.hours, rain: scenario.rain, depth, relative: scenario.relative });
  }

  function seek(value) {
    t = Math.max(0, Math.min((scenario?.hours.length ?? 1) - 1, value));
    timeline.setTime(t);
    if (!scenario) return;
    const v = sampleSeries(scenario.values, t);
    if (scenario.kind === 'volume') {
      if (state.area?.ready) setDepth(state.area.showVolume(v), scenario.source, { fromArea: true });
      else setDepth(approxDepth(v), `${scenario.source} · approximate, terrain not loaded`);
    } else setDepth(v, scenario.source);
    const k = Math.round(t);
    const rain = scenario.rain[k];
    $('#tl-time').textContent = `${timeline.label(t)}${rain > 0.05 ? ` · rain ${rain.toFixed(1)} mm/h` : ''}`;
  }

  function pause() {
    cancelAnimationFrame(raf);
    raf = 0;
    playResolve?.();
    playResolve = null;
    $('#play').textContent = 'Play the storm';
    $('#play').setAttribute('aria-pressed', 'false');
  }

  function play() {
    if (!scenario) return Promise.resolve();
    stopPlaying();
    pause();
    const length = scenario.hours.length - 1;
    if (t >= length - 0.01) t = scenario.startAt ?? 0;
    const from = t;
    const seconds = Math.max(9, Math.min(16, (length - from) * 0.22));
    const started = performance.now();
    $('#play').textContent = 'Pause';
    $('#play').setAttribute('aria-pressed', 'true');
    return new Promise((resolve) => {
      playResolve = resolve;
      const step = (now) => {
        const k = Math.min(1, (now - started) / (seconds * 1000));
        seek(from + (length - from) * k);
        if (k < 1) raf = requestAnimationFrame(step);
        else { raf = 0; playResolve = null; pause(); resolve(); }
      };
      raf = requestAnimationFrame(step);
    });
  }

  function select(id) {
    choice = id;
    document.querySelectorAll('[data-scenario]').forEach((button) => button.setAttribute('aria-checked', String(button.dataset.scenario === id)));
  }

  function field(label, control) {
    const wrap = el('div', 'field');
    const id = `p-${label.replace(/\W+/g, '-').toLowerCase()}`;
    control.id = id;
    const lab = el('label', '', label);
    lab.htmlFor = id;
    wrap.append(lab, control);
    return wrap;
  }

  function selectOf(options, value, onChange) {
    const node = el('select');
    node.replaceChildren(...options.map(([v, text]) => { const o = el('option', '', text); o.value = String(v); return o; }));
    node.value = String(value);
    node.addEventListener('change', () => onChange(node.value));
    return node;
  }

  function renderParams() {
    const box = $('#scenario-params');
    if (choice === 'rain') {
      box.replaceChildren(
        field('Rain', selectOf([[50, '50 mm'], [100, '100 mm'], [150, '150 mm'], [250, '250 mm'], [400, '400 mm']], params.rainMm, (v) => { params.rainMm = Number(v); choose('rain'); })),
        field('Falling over', selectOf([[3, '3 hours'], [6, '6 hours'], [12, '12 hours'], [24, '24 hours']], params.rainH, (v) => { params.rainH = Number(v); choose('rain'); })),
      );
    } else if (choice === 'river') {
      const rows = Object.entries(jrc?.depths ?? {}).map(([rp, cell]) => ({ rp: Number(rp), depth: Number(cell.here) > 0 ? Number(cell.here) : Number(cell.nearby) || 0 })).filter((r) => r.depth > 0);
      if (rows.length) {
        params.rp ??= rows.find((r) => r.rp === 100)?.rp ?? rows.at(-1).rp;
        box.replaceChildren(field('Flood size (JRC)', selectOf(rows.map((r) => [r.rp, `${YEARLY_CHANCE[r.rp] ?? `1 in ${r.rp}`} · ${r.depth.toFixed(1)} m`]), params.rp, (v) => { params.rp = Number(v); choose('river'); })));
      } else {
        box.replaceChildren(field('Peak at your spot', selectOf([[0.5, '0.5 m'], [1, '1 m'], [1.5, '1.5 m'], [2, '2 m'], [3, '3 m']], params.peak, (v) => { params.peak = Number(v); choose('river'); })));
      }
    } else if (choice === 'surge') {
      box.replaceChildren(field('Sea above your street', selectOf([[0.5, '0.5 m'], [1, '1 m'], [2, '2 m'], [3, '3 m'], [4, '4 m']], params.surge, (v) => { params.surge = Number(v); choose('surge'); })));
    } else box.replaceChildren();
  }

  function riverPeak() {
    const cell = jrc?.depths?.[params.rp];
    if (!cell) return null;
    const here = Number(cell.here) || 0;
    return { depth: here > 0 ? here : Number(cell.nearby) || 0, label: `${YEARLY_CHANCE[params.rp] ?? `1 in ${params.rp}`}${here > 0 ? '' : ', nearby maximum'}` };
  }

  /** Switch scenario. Returns the play promise when autoplaying. */
  function choose(id, { autoplay = true } = {}) {
    pause();
    select(id);
    renderParams();
    const areaM2 = state.area?.areaM2 ?? 3.24e6;
    let next = null;
    let note = '';
    if (id === 'forecast') {
      next = forecastScenario(weather, areaM2);
      if (next && weather?.hourly?.time) next.startAt = Math.max(0, nowIndex(weather.hourly.time, weather.place?.timezone));
      if (!next) note = pin ? 'The forecast is still loading or unavailable here. Try again in a moment.' : 'Choose a place first.';
    } else if (id === 'event') {
      if (eventData) next = eventScenario(eventData.data, eventData.scene);
    } else if (id === 'rain') {
      next = heavyRainScenario(params.rainMm, params.rainH, areaM2);
    } else if (id === 'river') {
      const peak = riverPeak();
      next = peak ? riverScenario(peak.depth, peak.label) : riverScenario(params.peak, `illustrative ${params.peak} m`);
      if (!peak) note = jrc ? 'The JRC model shows no river flooding at this spot, so this is an illustrative river flood. ' : '';
    } else if (id === 'surge') {
      next = surgeScenario(params.surge, weather?.sea);
      // The marine model answers for the nearest sea cell, which can be kilometres away.
      const sea = weather?.sea;
      const away = sea && pin ? Math.hypot((sea.lat - Cesium.Math.toDegrees(pin.lat)) * 111, (sea.lon - Cesium.Math.toDegrees(pin.lon)) * 111 * Math.cos(pin.lat)) : Infinity;
      if (!(away < 3)) note = `The nearest open sea in the marine forecast is ${Number.isFinite(away) ? `about ${away.toFixed(0)} km` : 'far'} away, so a surge this high is unlikely here. `;
    }
    scenario = next;
    $('#scenario-note').textContent = note + (next?.note ?? (id === 'manual' ? 'Drag the water level under the map, or tap a depth.' : ''));
    $('#tl-title').textContent = next?.title ?? 'Set by hand';
    if (!next) {
      timeline.set(null);
      $('#tl-time').textContent = 'Drag the water level, or pick a storm in Simulate';
      $('#play').textContent = 'Play the flood';
      return Promise.resolve();
    }
    rebuildSeries();
    seek(next.startAt ?? 0);
    return autoplay ? play() : Promise.resolve();
  }

  // ---------- events and places ----------

  function trimWindow(data, window) {
    const times = data?.hourly?.time ?? [];
    if (!window || !times.length) return data;
    const a = times.findIndex((time) => time >= window[0]);
    let b = times.findIndex((time) => time > window[1]);
    if (b < 0) b = times.length;
    if (a < 0 || b <= a) return data;
    const hourly = Object.fromEntries(Object.entries(data.hourly).map(([key, list]) => [key, Array.isArray(list) ? list.slice(a, b) : list]));
    return { ...data, hourly };
  }

  async function loadEvent(scene) {
    if (!scene?.event) return null;
    const { start, end, window } = scene.event;
    const data = await withDirectFallback(
      () => askServer(`/api/weather/event?lat=${scene.lat}&lon=${scene.lon}&start=${start}&end=${end}`),
      () => fetchEventDirect(scene.lat, scene.lon, start, end),
    );
    eventData = { scene, data: trimWindow(data, window) };
    const button = document.querySelector('[data-scenario="event"]');
    button.hidden = false;
    $('#event-label').textContent = scene.event.title;
    return eventData;
  }

  /** Replay a real flood's recorded storm over the scene. Resolves when the replay ends. */
  async function playEvent(scene, { waitForAreaMs = 25_000 } = {}) {
    try {
      await loadEvent(scene);
    } catch (error) {
      console.warn('Event rainfall unavailable.', error);
      return false;
    }
    if (areaReady) await Promise.race([areaReady, new Promise((resolve) => setTimeout(resolve, waitForAreaMs))]);
    await choose('event');
    return true;
  }

  function onPin(nextPin) {
    pause();
    pin = nextPin;
    weather = null;
    jrc = null;
    placeName = 'Your spot';
    $('#wx-sub').textContent = `${Cesium.Math.toDegrees(nextPin.lat).toFixed(4)}°, ${Cesium.Math.toDegrees(nextPin.lon).toFixed(4)}°`;
    renderWeather();
    if (eventData && Math.hypot(eventData.scene.lat - Cesium.Math.toDegrees(nextPin.lat), eventData.scene.lon - Cesium.Math.toDegrees(nextPin.lon)) > 0.02) {
      eventData = null;
      document.querySelector('[data-scenario="event"]').hidden = true;
    }
    if (choice !== 'manual') { scenario = null; select('manual'); timeline.set(null); $('#tl-title').textContent = 'Set by hand'; $('#scenario-note').textContent = ''; renderParams(); }
    if (state.mode === 'studio') { areaReady = Promise.resolve(false); return; }
    buildArea(nextPin);
    loadWeather(nextPin);
    loadJrc(nextPin);
  }

  document.querySelectorAll('[data-scenario]').forEach((button) => {
    button.addEventListener('click', () => choose(button.dataset.scenario).catch?.((error) => toast(error.message)));
  });
  select('manual');
  timeline.set(null);

  return {
    onPin, onStats, choose, play, pause, playEvent, loadEvent, seek,
    setPlace(name) { placeName = name || ''; renderWeather(); },
    setManual() { if (choice !== 'manual') { pause(); scenario = null; select('manual'); timeline.set(null); $('#tl-title').textContent = 'Set by hand'; $('#scenario-note').textContent = ''; renderParams(); } },
    get active() { return Boolean(scenario); },
    get playing() { return Boolean(raf); },
    get scenario() { return scenario; },
    get areaReady() { return areaReady; },
    get weather() { return weather; },
  };
}
