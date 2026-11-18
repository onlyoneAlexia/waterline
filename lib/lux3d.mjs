// Minimal client for the Aholo Lux3D OpenAPI (international region).
//
// The request/response contract mirrors Manycore's official client in
// github.com/manycore-research/ComfyUI-Lux3D (lux3d_openapi/*.py):
//   - every call sends the raw API key in the `Authorization` header
//   - responses use an envelope { c: code, m: message, d: data }; c == "0" is success
//   - local images go through Asset/OUS upload first, which returns a public URL
//   - generation is asynchronous: create a task, then poll task/get until status 3/4/6

import { createHash } from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://api.aholo.ai/global';
export const DEFAULT_FACE_COUNT = 60_000;

const TASK_STATES = { 0: 'queued', 1: 'running', 3: 'succeeded', 4: 'failed', 6: 'cancelled' };
const OUS_SUCCESS = 5;
const OUS_FAILED = new Set([6, 8]);

export class Lux3DError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Flatten task outputs into a list of URLs (some outputs hold a JSON array string). */
export function extractOutputUrls(outputs) {
  const urls = [];
  for (const output of outputs ?? []) {
    const content = typeof output?.content === 'string' ? output.content.trim() : '';
    if (!content || content.toUpperCase() === 'NOT_REQUESTED') continue;
    if (content.startsWith('[')) {
      try {
        const nested = JSON.parse(content);
        if (Array.isArray(nested)) {
          urls.push(...nested.filter((item) => typeof item === 'string' && item.trim()));
          continue;
        }
      } catch {
        // not JSON: fall through and treat as a plain URL
      }
    }
    urls.push(content);
  }
  return urls;
}

function hasSuffix(url, suffix) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(suffix);
  } catch {
    return false;
  }
}

export function createLux3D({ apiKey, baseUrl = DEFAULT_BASE_URL, timeoutMs = 30_000, retryDelayMs = 1000, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Lux3DError('LUX3D_API_KEY is not set');
  }
  const key = apiKey.trim();
  const base = baseUrl.replace(/\/+$/, '');
  const secrets = [key];
  const redact = (value) => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value ?? ''));

  async function requestJson(url, { method = 'GET', headers = {}, body, query } = {}) {
    const target = new URL(url);
    for (const [name, value] of Object.entries(query ?? {})) target.searchParams.set(name, String(value));
    // GETs are safe to repeat, so ride out brief network blips and 5xx errors.
    // POSTs are not retried: a lost response might still have created a task.
    const attempts = method === 'GET' ? 3 : 1;
    let response;
    for (let attempt = 1; ; attempt++) {
      try {
        response = await fetchImpl(target, {
          method,
          headers: { Accept: 'application/json', ...headers },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status < 500 || attempt >= attempts) break;
      } catch (error) {
        if (attempt >= attempts) {
          throw new Lux3DError(`${method} ${target.pathname} failed (${error?.name ?? 'network error'})`);
        }
      }
      await sleep(retryDelayMs * attempt);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Lux3DError(`${method} ${target.pathname} returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const message = redact(payload?.m ?? payload?.message ?? '');
      throw new Lux3DError(`${method} ${target.pathname} failed with HTTP ${response.status}${message ? `: ${message}` : ''}`);
    }
    return payload;
  }

  function unwrap(payload, operation) {
    if (payload && typeof payload === 'object' && 'c' in payload) {
      const code = payload.c;
      if (!(code === null || code === '' || code === '0' || code === 0)) {
        throw new Lux3DError(`${operation} failed (code ${code}): ${redact(payload.m ?? 'unknown error')}`);
      }
      return payload.d;
    }
    return payload;
  }

  async function api(method, path, { json, query } = {}) {
    const payload = await requestJson(base + path, {
      method,
      query,
      headers: { Authorization: key, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
    return unwrap(payload, `${method} ${path}`);
  }

  /** Upload image bytes through Asset/OUS and return the public URL Lux3D can read. */
  async function uploadImage(buffer, filename = 'photo.jpg') {
    if (!buffer?.length) throw new Lux3DError('Image is empty');
    const token = await api('GET', '/asset/v1/token');
    const ousToken = token?.ousToken?.trim();
    const domain = typeof token?.globalDomain === 'string' ? token.globalDomain.replace(/\/+$/, '') : '';
    if (!ousToken || !domain.startsWith('https://')) {
      throw new Lux3DError('Asset token response is missing ousToken or globalDomain');
    }
    secrets.push(ousToken);
    if (Number.isInteger(token.blockSize) && buffer.length > token.blockSize) {
      throw new Lux3DError(`Image is too large (${buffer.length} bytes; limit ${token.blockSize}). Use a smaller photo.`);
    }

    const headers = { 'ous-token-v2': ousToken };
    const form = new FormData();
    form.set('md5', createHash('md5').update(buffer).digest('hex'));
    form.set('file', new Blob([buffer], { type: 'application/octet-stream' }), filename);
    unwrap(await requestJson(`${domain}/ous/api/v2/single/upload`, { method: 'POST', headers, body: form }), 'Image upload');

    const started = Date.now();
    for (;;) {
      const status = unwrap(await requestJson(`${domain}/ous/api/v2/upload/status`, { headers }), 'Upload status');
      if (status?.status === OUS_SUCCESS) {
        if (typeof status.url !== 'string' || !status.url.trim()) throw new Lux3DError('Upload finished without a URL');
        return status.url.trim();
      }
      if (OUS_FAILED.has(status?.status)) {
        throw new Lux3DError(`Image upload failed (status ${status.status}) ${redact(status.errorMsg ?? status.errorInfo ?? '')}`.trim());
      }
      if (Date.now() - started > 120_000) throw new Lux3DError('Image upload did not finish within 2 minutes');
      await sleep(500);
    }
  }

  function generationOptions(options = {}) {
    const body = {
      version: options.version ?? 'G1-Turbo',
      outputFormat: ['glb'],
      aiPredictSize: options.aiPredictSize ?? true,
    };
    // PBR materials are only supported by G1-Turbo.
    if (body.version === 'G1-Turbo') body.enablePbr = options.enablePbr ?? true;
    // Lux3D's default was ~280k triangles (17 MB) for a car: far more than a street
    // scene needs. 60k keeps the shape and loads ~4x faster. Pass 0 to use Lux3D's default.
    const faceCount = options.faceCount ?? DEFAULT_FACE_COUNT;
    if (faceCount) body.faceCount = faceCount;
    return body;
  }

  function taskIdFrom(data) {
    const id = String(data ?? '').trim();
    if (!/^\d+$/.test(id)) throw new Lux3DError('Create-task response did not include a task id');
    return id;
  }

  async function createImageTo3D(imageUrl, options) {
    return taskIdFrom(await api('POST', '/lux3d/v1/generate/img-to-3d/task/create', {
      json: { ...generationOptions(options), img: imageUrl },
    }));
  }

  async function createTextTo3D(prompt, options = {}) {
    return taskIdFrom(await api('POST', '/lux3d/v1/generate/text-to-3d/task/create', {
      json: { ...generationOptions(options), prompt, style: options.style ?? 'photorealistic' },
    }));
  }

  async function getTask(taskId) {
    const data = await api('GET', '/lux3d/v1/generate/task/get', { query: { taskid: taskId } });
    if (!data || typeof data !== 'object') throw new Lux3DError('Task response is missing data');
    const urls = extractOutputUrls(data.outputs);
    return {
      taskId: String(data.taskId ?? taskId),
      status: data.status,
      state: TASK_STATES[data.status] ?? 'unknown',
      glbUrl: urls.find((url) => hasSuffix(url, '.glb')) ?? null,
      urls,
      message: redact(data.message ?? data.errorMessage ?? data.error ?? ''),
    };
  }

  async function waitForTask(taskId, { intervalMs = 10_000, timeoutMs: limitMs = 15 * 60_000, onProgress } = {}) {
    const started = Date.now();
    for (;;) {
      const task = await getTask(taskId);
      onProgress?.(task, Date.now() - started);
      if (task.state === 'succeeded') return task;
      if (task.state === 'failed' || task.state === 'cancelled') {
        throw new Lux3DError(`Lux3D task ${taskId} ${task.state}${task.message ? `: ${task.message}` : ''}`);
      }
      if (Date.now() - started > limitMs) throw new Lux3DError(`Lux3D task ${taskId} timed out`);
      await sleep(intervalMs);
    }
  }

  // ---------- Aholo World: a whole 3D room (Gaussian splats) from one photo or a description ----------

  const WORLD_STATES = { PENDING: 'queued', PREPROCESSING: 'queued', RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELED: 'cancelled', TIMEOUT: 'failed', REJECTED: 'failed' };

  async function createWorld({ prompt = '', imageUrl, name = 'Waterline room' } = {}) {
    const text = String(prompt ?? '').trim();
    if (!text && !imageUrl) throw new Lux3DError('A world needs a description or a photo');
    const body = { name: String(name).slice(0, 60), prompt: text || 'an indoor ground-floor room' };
    if (imageUrl) body.resources = [{ url: imageUrl, type: 'image' }];
    const data = await api('POST', '/world/v1/generations', { json: body });
    const id = String(data?.worldId ?? '').trim();
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new Lux3DError('Create-world response did not include a world id');
    return id;
  }

  async function getWorld(worldId) {
    const data = await api('GET', `/world/v1/${encodeURIComponent(worldId)}`);
    if (!data || typeof data !== 'object') throw new Lux3DError('World response is missing data');
    const urls = data.assets?.splats?.urls ?? {};
    return {
      worldId: String(data.worldId ?? worldId),
      status: data.status,
      state: WORLD_STATES[data.status] ?? 'unknown',
      progress: Number.isFinite(data.progress) ? data.progress : null,
      spzUrl: typeof urls.spzPath === 'string' ? urls.spzPath : null,
      plyUrl: typeof urls.plyPath === 'string' ? urls.plyPath : null,
      panoUrl: typeof data.assets?.imagery?.panoUrl === 'string' ? data.assets.imagery.panoUrl : null,
      upAxis: data.assets?.semanticsMetadata?.upAxis === 'Y' ? 'Y' : 'Z',
      message: redact(data.message ?? data.errorMessage ?? data.error ?? ''),
    };
  }

  return { uploadImage, createImageTo3D, createTextTo3D, getTask, waitForTask, createWorld, getWorld };
}

/** Download a GLB and check it really is one before it is saved. */
export async function downloadGlb(url, { fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Lux3DError(`Model download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'glTF') {
    throw new Lux3DError('Downloaded file is not a GLB model');
  }
  return bytes;
}
