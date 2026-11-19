// HTTP handlers for Lux3D multi-format export: turn a model the app already serves into
// USDZ (iPhone AR Quick Look), STL or 3MF (3D printing).
//
//   POST /api/export   body { model: '/models/…/x.glb', format: 'usdz' | 'stl' | '3mf' } -> { taskId }
//   GET  /api/export?id=<taskId>  -> { state: 'queued'|'running' } | { state: 'done', url, format } | { state: 'failed', error }
//
// Wire-up (server.mjs): const extras = createExtrasHandlers({ lux, generatedDir });
//   if (url.pathname === '/api/export') return await extras.handleExport(req, res, url, sendJson);
// Finished files are saved to <generatedDir>/exports/<taskId>.<format> and served from
// /models/generated/exports/. Only ids this handler created are polled. Each new export spends
// Lux3D credits, so there is a simple daily cap (maxPerDay) and repeat requests reuse a task.

import { readFile, writeFile, mkdir, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { downloadFile, exportUrls } from './lux3d.mjs';

export const EXPORTABLE_FORMATS = ['usdz', 'stl', '3mf'];
const MAX_BODY_BYTES = 4096;
const MAX_MODEL_BYTES = 60 * 1024 * 1024;
const MODEL_PATH = /^\/models\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.glb$/;

/** Resolve a public model URL path ('/models/…glb') to a file under modelsDir, or null if it is not one. */
export function resolveModelPath(modelsDir, model) {
  if (typeof model !== 'string' || model.length > 300 || !MODEL_PATH.test(model)) return null;
  if (model.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  const root = path.resolve(modelsDir);
  const file = path.resolve(root, ...model.slice('/models/'.length).split('/'));
  return file.startsWith(root + path.sep) ? file : null;
}

async function readSmallJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request is too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Request body must be JSON'), { status: 400 });
  }
}

const exists = (file) => access(file).then(() => true, () => false);

export function createExtrasHandlers({ lux, generatedDir, fetchImpl = fetch, modelsDir = path.dirname(generatedDir), maxPerDay = 20, downloadExport = downloadFile } = {}) {
  if (!generatedDir) throw new Error('generatedDir is required');
  const exportsDir = path.join(generatedDir, 'exports');
  const publicBase = '/models/generated/exports';
  const tasks = new Map(); // taskId -> { model, format, createdAt }
  const byRequest = new Map(); // `${model}|${format}|${mtime}` -> taskId (do not pay twice for the same file)
  const inflight = new Map(); // taskId -> Promise of a status check
  let quotaDay = '';
  let quotaUsed = 0;

  function takeQuota() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== quotaDay) { quotaDay = today; quotaUsed = 0; }
    if (quotaUsed >= maxPerDay) return 'The demo has used up today’s exports. Please try again tomorrow.';
    quotaUsed += 1;
    return null;
  }

  const savedFile = (taskId, format) => path.join(exportsDir, `${taskId}.${format}`);

  async function startExport(req, res, sendJson) {
    if (!lux) return sendJson(res, 503, { error: 'Export is not configured on this server.' });
    let body;
    try {
      body = await readSmallJson(req);
    } catch (error) {
      return sendJson(res, error.status ?? 400, { error: error.message });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'Request body must be a JSON object.' });
    const format = String(body.format ?? '').toLowerCase();
    if (!EXPORTABLE_FORMATS.includes(format)) return sendJson(res, 400, { error: `format must be one of ${EXPORTABLE_FORMATS.join(', ')}` });
    const file = resolveModelPath(modelsDir, body.model);
    if (!file) return sendJson(res, 400, { error: 'model must be a .glb path under /models/' });
    let info;
    try {
      info = await stat(file);
    } catch {
      return sendJson(res, 404, { error: 'Model not found' });
    }
    if (!info.isFile()) return sendJson(res, 404, { error: 'Model not found' });
    if (info.size > MAX_MODEL_BYTES) return sendJson(res, 413, { error: 'Model is too large to export' });

    const key = `${body.model}|${format}|${info.mtimeMs}`;
    const known = byRequest.get(key);
    if (known) {
      if (await exists(savedFile(known, format))) return sendJson(res, 200, { taskId: known, state: 'done', url: `${publicBase}/${known}.${format}`, format });
      return sendJson(res, 200, { taskId: known });
    }

    const blocked = takeQuota();
    if (blocked) return sendJson(res, 429, { error: blocked });
    const modelUrl = await lux.uploadFile(await readFile(file), path.basename(file));
    const taskId = await lux.createMultiFormatExport(modelUrl, [format]);
    tasks.set(taskId, { model: body.model, format, createdAt: Date.now() });
    byRequest.set(key, taskId);
    console.log(`[lux3d] export task ${taskId} created (${body.model} -> ${format})`);
    return sendJson(res, 200, { taskId });
  }

  async function checkExport(taskId) {
    const { format } = tasks.get(taskId);
    const task = await lux.getTask(taskId);
    if (task.state === 'succeeded') {
      const result = exportUrls(task.contents)[format];
      if (!result) return { state: 'failed', error: `Lux3D finished but returned no ${format} file.` };
      const bytes = await downloadExport(result, { kind: format, fetchImpl });
      await mkdir(exportsDir, { recursive: true });
      await writeFile(savedFile(taskId, format), bytes);
      console.log(`[lux3d] export ${taskId} saved (${format}, ${(bytes.length / 1e6).toFixed(1)} MB)`);
      return { state: 'done', url: `${publicBase}/${taskId}.${format}`, format };
    }
    if (task.state === 'failed' || task.state === 'cancelled') {
      return { state: 'failed', error: task.message || `Lux3D export ${task.state}.` };
    }
    return { state: task.state };
  }

  async function pollExport(url, res, sendJson) {
    const taskId = url.searchParams.get('id') ?? '';
    if (!/^\d{1,30}$/.test(taskId)) return sendJson(res, 400, { error: 'Invalid task id' });
    for (const format of EXPORTABLE_FORMATS) {
      if (await exists(savedFile(taskId, format))) return sendJson(res, 200, { state: 'done', url: `${publicBase}/${taskId}.${format}`, format });
    }
    if (!lux || !tasks.has(taskId)) return sendJson(res, 404, { error: 'Unknown export' });
    if (!inflight.has(taskId)) inflight.set(taskId, checkExport(taskId).finally(() => inflight.delete(taskId)));
    return sendJson(res, 200, await inflight.get(taskId));
  }

  /** Handles POST (start) and GET (poll) on /api/export. */
  async function handleExport(req, res, url, sendJson) {
    if (req.method === 'POST') return startExport(req, res, sendJson);
    if (req.method === 'GET') return pollExport(url, res, sendJson);
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  return { handleExport };
}
