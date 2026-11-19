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
const UPLOAD_TIMEOUT_MS = 180_000; // the per-request timeout covers the whole body, so give 5 MB parts room

/** Parts still to send after a multipart init: lackBlocks holds "a-b" or "n" ranges, or null for all. */
export function missingBlocks(lackBlocks, blocks) {
  const all = Array.from({ length: blocks }, (_, i) => i + 1);
  if (!Array.isArray(lackBlocks) || !lackBlocks.length) return all;
  const wanted = new Set();
  for (const range of lackBlocks) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(range));
    if (!match) return all;
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    for (let block = from; block <= to; block++) if (block >= 1 && block <= blocks) wanted.add(block);
  }
  return wanted.size ? [...wanted].sort((a, b) => a - b) : all;
}

// The 85 retargetable clips include Walk_Loop, Jog_Fwd_Loop, Sprint_Loop, Swim_Fwd_Loop, Idle_Loop …
export const WALK_ANIMATION = 'Walk_Loop';
export const MATERIAL_TRANSFER_VERSION = 'v3.0-standard';
export const MATERIAL_TRANSFER_ORDER = ['zip', 'glb', 'usdz', 'obj_zip', 'fbx_zip'];

export class Lux3DError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Flatten task outputs into a list of URLs (some outputs hold a JSON array string). */
export function extractOutputUrls(outputs) {
  const urls = [];
  for (const output of outputs ?? []) {
    const content = typeof output?.content === 'string' ? output.content.trim() : '';
    if (!content || content.toUpperCase() === 'NOT_REQUESTED') continue;
    if (content.startsWith('{')) continue; // a JSON result object (rigging error, retarget actions), not a URL
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

const isHttpUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim());

function parseJsonObject(content) {
  if (typeof content !== 'string' || !content.trim().startsWith('{')) return null;
  try {
    const value = JSON.parse(content);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The error a task reports inside its outputs, e.g. auto-rigging's {"error":{"code","message"}}. */
export function outputError(contents) {
  for (const content of contents ?? []) {
    const value = parseJsonObject(content);
    const error = value?.error;
    if (error) return typeof error === 'string' ? error : [error.code, error.message].filter(Boolean).join(': ');
    const failed = value?.actions?.find?.((action) => action?.status !== 'success' && action?.error);
    if (failed) return `${failed.animation_id ?? 'animation'}: ${[failed.error.code, failed.error.message].filter(Boolean).join(': ')}`;
  }
  return '';
}

/** Humanoid animation retargeting returns {"actions":[{animation_id,status,animationGlbUrl|fbxUrl|error}]}. */
export function retargetActions(contents) {
  const actions = [];
  for (const content of contents ?? []) {
    for (const action of parseJsonObject(content)?.actions ?? []) {
      actions.push({
        animationId: String(action?.animation_id ?? action?.animationId ?? ''),
        status: String(action?.status ?? ''),
        glbUrl: isHttpUrl(action?.animationGlbUrl) ? action.animationGlbUrl.trim() : null,
        fbxUrl: isHttpUrl(action?.fbxUrl) ? action.fbxUrl.trim() : null,
        error: action?.error ? [action.error.code, action.error.message].filter(Boolean).join(': ') : '',
      });
    }
  }
  return actions;
}

// Multi-format export outputs, in the order the task query documents.
export const EXPORT_OUTPUT_ORDER = ['zip', 'glb', 'usdz', 'obj_zip', 'fbx_zip', 'stl', '3mf'];
export const EXPORT_FORMATS = ['usdz', 'obj_zip', 'fbx_zip', 'stl', '3mf'];
const SUFFIX_FORMATS = [['.usdz', 'usdz'], ['.stl', 'stl'], ['.3mf', '3mf'], ['.glb', 'glb']];

/** Map multi-format export (or material transfer) outputs to { usdz, stl, 3mf, glb, … } URLs. */
export function exportUrls(contents, order = EXPORT_OUTPUT_ORDER) {
  const list = contents ?? [];
  const positional = list.length === order.length;
  const result = {};
  list.forEach((content, index) => {
    if (!isHttpUrl(content)) return; // NOT_REQUESTED placeholders and blanks
    const url = content.trim();
    const bySuffix = SUFFIX_FORMATS.find(([suffix]) => hasSuffix(url, suffix))?.[1];
    const format = bySuffix ?? (positional ? order[index] : hasSuffix(url, '.zip') ? 'zip' : null);
    if (format && !result[format]) result[format] = url;
  });
  return result;
}

export function createLux3D({ apiKey, baseUrl = DEFAULT_BASE_URL, timeoutMs = 30_000, retryDelayMs = 1000, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Lux3DError('LUX3D_API_KEY is not set');
  }
  const key = apiKey.trim();
  const base = baseUrl.replace(/\/+$/, '');
  const secrets = [key];
  const redact = (value) => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value ?? ''));

  async function requestJson(url, { method = 'GET', headers = {}, body, query, requestTimeoutMs = timeoutMs } = {}) {
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
          signal: AbortSignal.timeout(requestTimeoutMs),
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

  /** A fresh OUS upload credential; upload status is bound to the token, so use one per file. */
  async function uploadToken() {
    const token = await api('GET', '/asset/v1/token');
    const ousToken = token?.ousToken?.trim();
    const domain = typeof token?.globalDomain === 'string' ? token.globalDomain.replace(/\/+$/, '') : '';
    if (!ousToken || !domain.startsWith('https://')) {
      throw new Lux3DError('Asset token response is missing ousToken or globalDomain');
    }
    secrets.push(ousToken);
    return { domain, headers: { 'ous-token-v2': ousToken }, blockSize: Number.isInteger(token.blockSize) && token.blockSize > 0 ? token.blockSize : null };
  }

  async function singleUpload({ domain, headers }, buffer, filename, label) {
    const form = new FormData();
    form.set('md5', createHash('md5').update(buffer).digest('hex'));
    form.set('file', new Blob([buffer], { type: 'application/octet-stream' }), filename);
    unwrap(await requestJson(`${domain}/ous/api/v2/single/upload`, { method: 'POST', headers, body: form, requestTimeoutMs: UPLOAD_TIMEOUT_MS }), label);
  }

  async function waitForUpload({ domain, headers }, label) {
    const started = Date.now();
    for (;;) {
      const status = unwrap(await requestJson(`${domain}/ous/api/v2/upload/status`, { headers }), 'Upload status');
      if (status?.status === OUS_SUCCESS) {
        if (typeof status.url !== 'string' || !status.url.trim()) throw new Lux3DError('Upload finished without a URL');
        return status.url.trim();
      }
      if (OUS_FAILED.has(status?.status)) {
        throw new Lux3DError(`${label} failed (status ${status.status}) ${redact(status.errorMsg ?? status.errorInfo ?? status.errorCode ?? '')}`.trim());
      }
      if (Date.now() - started > 120_000) throw new Lux3DError(`${label} did not finish within 2 minutes`);
      await sleep(500);
    }
  }

  /** Upload image bytes through Asset/OUS and return the public URL Lux3D can read. */
  async function uploadImage(buffer, filename = 'photo.jpg') {
    if (!buffer?.length) throw new Lux3DError('Image is empty');
    const token = await uploadToken();
    if (token.blockSize && buffer.length > token.blockSize) {
      throw new Lux3DError(`Image is too large (${buffer.length} bytes; limit ${token.blockSize}). Use a smaller photo.`);
    }
    await singleUpload(token, buffer, filename, 'Image upload');
    return waitForUpload(token, 'Image upload');
  }

  /**
   * Upload any file (e.g. a GLB model) and return its public URL. Files larger than the
   * token's blockSize (5 MB today) go up in parts: init (query only), then each 1-based part.
   */
  async function uploadFile(buffer, filename = 'model.glb') {
    if (!buffer?.length) throw new Lux3DError('File is empty');
    const token = await uploadToken();
    if (!token.blockSize || buffer.length <= token.blockSize) {
      await singleUpload(token, buffer, filename, 'File upload');
      return waitForUpload(token, 'File upload');
    }
    const blocks = Math.ceil(buffer.length / token.blockSize);
    const init = unwrap(await requestJson(`${token.domain}/ous/api/v2/block/upload/init`, {
      method: 'POST',
      headers: token.headers,
      query: { md5: createHash('md5').update(buffer).digest('hex'), blocks, size: buffer.length, name: filename },
    }), 'Multipart upload init');
    if (!init?.deduplicated) { // deduplicated: OUS already has this file, so skip the parts
      const missing = missingBlocks(init?.lackBlocks, blocks);
      for (const block of missing) {
        const form = new FormData();
        form.set('block', String(block));
        const start = (block - 1) * token.blockSize;
        form.set('file', new Blob([buffer.subarray(start, start + token.blockSize)], { type: 'application/octet-stream' }), filename);
        unwrap(await requestJson(`${token.domain}/ous/api/v2/block/upload/part`, {
          method: 'POST', headers: token.headers, body: form, requestTimeoutMs: UPLOAD_TIMEOUT_MS,
        }), `Upload part ${block}/${blocks}`);
      }
    }
    return waitForUpload(token, 'File upload');
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

  // ---------- Lux3D model tools: rig, animate, export, split, re-texture ----------
  // Every one takes a public model/image URL (upload local files with uploadFile/uploadImage
  // first), returns a task id, and is polled with getTask/waitForTask like generation.

  function requireUrl(value, name) {
    if (!isHttpUrl(value)) throw new Lux3DError(`${name} must be a public http(s) URL`);
    return value.trim();
  }

  function requireText(value, name) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) throw new Lux3DError(`${name} must not be blank`);
    return text;
  }

  /** Humanoid auto-rigging: GLB of a person in, rigged GLB out (outputs[0]). */
  async function createHumanoidRig(modelUrl) {
    return taskIdFrom(await api('POST', '/lux3d/v1/animations/rig/task/create', {
      json: { modelUrl: requireUrl(modelUrl, 'modelUrl') },
    }));
  }

  /** Apply 1-10 library clips (e.g. Walk_Loop) to a rigged GLB. Read results with retargetActions(). */
  async function createAnimationRetarget(rigModelUrl, { animationIds = [WALK_ANIMATION], outputMode = 'separate', outFormat = 'glb', inPlace = false } = {}) {
    const ids = [...new Set(animationIds)];
    if (!ids.length || ids.length > 10) throw new Lux3DError('Pick between 1 and 10 animations');
    return taskIdFrom(await api('POST', '/lux3d/v1/animations/retarget/task/create', {
      json: { rigModelUrl: requireUrl(rigModelUrl, 'rigModelUrl'), animationIds: ids, animationOutputMode: outputMode, outFormat, animateInPlace: Boolean(inPlace) },
    }));
  }

  /** Convert a GLB (or a Lux3D result ZIP) to usdz / stl / 3mf / obj_zip / fbx_zip. Read results with exportUrls(). */
  async function createMultiFormatExport(modelUrl, formats) {
    const list = [...new Set(formats ?? [])];
    if (!list.length) throw new Lux3DError('Pick at least one export format');
    const unknown = list.find((format) => !EXPORT_FORMATS.includes(format));
    if (unknown) throw new Lux3DError(`Unsupported export format: ${unknown}`);
    return taskIdFrom(await api('POST', '/lux3d/v1/multi-format-export/task/create', {
      json: { modelUrl: requireUrl(modelUrl, 'modelUrl'), outputFormat: list },
    }));
  }

  /** Split a GLB into named parts (one GLB out). Only one split may run per account at a time. */
  async function createPartSplit(glbUrl) {
    return taskIdFrom(await api('POST', '/lux3d/v1/part-split/task/create', {
      json: { glbUrl: requireUrl(glbUrl, 'glbUrl') },
    }));
  }

  /** Re-texture a GLB from a reference image. Size is preserved unless customSize (mm) is given. */
  async function createMaterialTransfer(meshUrl, imageUrl, { outputFormat = ['glb'], customSize } = {}) {
    const json = { img: requireUrl(imageUrl, 'img'), meshUrl: requireUrl(meshUrl, 'meshUrl'), version: MATERIAL_TRANSFER_VERSION, outputFormat };
    if (Number(customSize) > 0) json.customSize = Number(customSize);
    return taskIdFrom(await api('POST', '/lux3d/v1/generate/material-transfer/task/create', { json }));
  }

  function multimodalBody({ prompt, imageUrl } = {}) {
    const json = {};
    if (imageUrl != null) json.img = requireUrl(imageUrl, 'img');
    if (prompt != null) json.prompt = requireText(prompt, 'prompt');
    if (!json.img && !json.prompt) throw new Lux3DError('Give a prompt, an image, or both');
    return json;
  }

  /** One image from a prompt and/or a reference image (outputs[0] is the image URL). */
  async function createMultimodalImage(input) {
    return taskIdFrom(await api('POST', '/lux3d/v1/generate/multimodal-to-image/task/create', { json: multimodalBody(input) }));
  }

  /** Four views of an object (front ¾, opposite ¾, side, back) from a prompt and/or image. */
  async function createFourView(input) {
    return taskIdFrom(await api('POST', '/lux3d/v1/generate/image-to-four-view/task/create', { json: multimodalBody(input) }));
  }

  /** Add joints and motion to a GLB from a prompt, e.g. "hinge the door so it swings open". */
  async function createArticulation(glbUrl, prompt) {
    return taskIdFrom(await api('POST', '/lux3d/v1/articulation-animation/task/create', {
      json: { glbUrl: requireUrl(glbUrl, 'glbUrl'), prompt: requireText(prompt, 'prompt') },
    }));
  }

  async function getTask(taskId) {
    const data = await api('GET', '/lux3d/v1/generate/task/get', { query: { taskid: taskId } });
    if (!data || typeof data !== 'object') throw new Lux3DError('Task response is missing data');
    const urls = extractOutputUrls(data.outputs);
    const contents = (data.outputs ?? []).map((output) => (typeof output?.content === 'string' ? output.content.trim() : ''));
    return {
      taskId: String(data.taskId ?? taskId),
      status: data.status,
      state: TASK_STATES[data.status] ?? 'unknown',
      glbUrl: urls.find((url) => hasSuffix(url, '.glb')) ?? null,
      urls,
      contents, // raw output contents: URLs, NOT_REQUESTED placeholders or JSON result strings
      message: redact((data.message ?? data.errorMessage ?? data.error) || outputError(contents)),
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

  return {
    uploadImage, uploadFile, createImageTo3D, createTextTo3D, getTask, waitForTask, createWorld, getWorld,
    createHumanoidRig, createAnimationRetarget, createMultiFormatExport, createPartSplit, createMaterialTransfer,
    createMultimodalImage, createFourView, createArticulation,
  };
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

/** Does this look like the file type Lux3D said it would be? (magic bytes, or STL's size rule) */
export function looksLike(kind, bytes) {
  const ascii = (start, end) => bytes.toString('latin1', start, end);
  switch (kind) {
    case 'glb': return bytes.length >= 12 && ascii(0, 4) === 'glTF';
    case 'usdz': case '3mf': case 'zip': case 'obj_zip': case 'fbx_zip':
      return bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50; // PK\x03\x04
    case 'stl':
      if (bytes.length >= 84 && bytes.length === 84 + 50 * bytes.readUInt32LE(80)) return true; // binary
      return /^\s*solid\b/.test(ascii(0, 256)) && ascii(0, 4096).includes('facet');
    case 'png': return bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47;
    case 'jpg': return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'webp': return bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'image': return ['png', 'jpg', 'webp'].some((type) => looksLike(type, bytes));
    default: return bytes.length > 0;
  }
}

/** Download a Lux3D result (USDZ, STL, 3MF, image, …), checking its type and size before it is saved. */
export async function downloadFile(url, { kind, fetchImpl = fetch, timeoutMs = 180_000, maxBytes = 200 * 1024 * 1024 } = {}) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Lux3DError(`Download failed with HTTP ${response.status}`);
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > maxBytes) throw new Lux3DError(`Download is too large (${declared} bytes)`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Lux3DError(`Download is too large (${bytes.length} bytes)`);
  if (!looksLike(kind, bytes)) throw new Lux3DError(`Downloaded file is not a valid ${kind ?? 'file'}`);
  return bytes;
}
