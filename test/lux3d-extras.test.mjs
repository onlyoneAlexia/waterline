import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {
  createLux3D, Lux3DError, missingBlocks, exportUrls, retargetActions, outputError, looksLike, downloadFile,
  extractOutputUrls, MATERIAL_TRANSFER_ORDER,
} from '../lib/lux3d.mjs';
import { createExtrasHandlers, resolveModelPath } from '../lib/lux3d-extras-routes.mjs';

const KEY = 'secret-key-123';
const BASE = 'https://api.aholo.ai/global';
const OUS = 'https://ous.example.com';

function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const target = new URL(url);
    calls.push({ url: target, init });
    const handler = routes[`${init.method ?? 'GET'} ${target.origin}${target.pathname}`];
    if (!handler) throw new Error(`unexpected request ${init.method ?? 'GET'} ${target}`);
    const [status, body] = await handler(target, init);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { impl, calls };
}

const uploadRoutes = (blockSize, extra = {}) => ({
  [`GET ${BASE}/asset/v1/token`]: () => [200, { ousToken: 'ous-tok', globalDomain: OUS, blockSize }],
  [`GET ${OUS}/ous/api/v2/upload/status`]: () => [200, { c: '0', d: { status: 5, url: 'https://cdn.example.com/model.glb' } }],
  ...extra,
});

test('uploadFile sends files larger than blockSize in 1-based parts', async () => {
  const parts = [];
  const { impl, calls } = mockFetch(uploadRoutes(10, {
    [`POST ${OUS}/ous/api/v2/block/upload/init`]: () => [200, { c: '0', d: { taskId: 1, lackBlocks: null, deduplicated: false } }],
    [`POST ${OUS}/ous/api/v2/block/upload/part`]: async (_url, init) => {
      parts.push({ block: init.body.get('block'), size: (await init.body.get('file').arrayBuffer()).byteLength });
      return [200, { c: '0', d: null }];
    },
  }));
  const lux = createLux3D({ apiKey: KEY, fetchImpl: impl });
  const url = await lux.uploadFile(Buffer.alloc(25, 7), 'car.glb');
  assert.equal(url, 'https://cdn.example.com/model.glb');
  const init = calls.find((c) => c.url.pathname.endsWith('/block/upload/init'));
  assert.equal(init.url.searchParams.get('blocks'), '3');
  assert.equal(init.url.searchParams.get('size'), '25');
  assert.equal(init.url.searchParams.get('name'), 'car.glb');
  assert.match(init.url.searchParams.get('md5'), /^[0-9a-f]{32}$/);
  assert.equal(init.init.body, undefined);
  assert.equal(init.init.headers['ous-token-v2'], 'ous-tok');
  assert.deepEqual(parts, [{ block: '1', size: 10 }, { block: '2', size: 10 }, { block: '3', size: 5 }]);
});

test('uploadFile skips parts when OUS already has the file, and uses single upload when small', async () => {
  let partCalls = 0;
  const { impl, calls } = mockFetch(uploadRoutes(10, {
    [`POST ${OUS}/ous/api/v2/block/upload/init`]: () => [200, { c: '0', d: { taskId: 1, deduplicated: true } }],
    [`POST ${OUS}/ous/api/v2/block/upload/part`]: () => { partCalls += 1; return [200, { c: '0', d: null }]; },
    [`POST ${OUS}/ous/api/v2/single/upload`]: () => [200, { c: '0', d: { taskId: '2' } }],
  }));
  const lux = createLux3D({ apiKey: KEY, fetchImpl: impl });
  await lux.uploadFile(Buffer.alloc(25), 'big.glb');
  assert.equal(partCalls, 0);
  await lux.uploadFile(Buffer.alloc(8), 'small.glb');
  assert.equal(calls.filter((c) => c.url.pathname.endsWith('/single/upload')).length, 1);
});

test('missingBlocks reads lackBlocks ranges', () => {
  assert.deepEqual(missingBlocks(null, 3), [1, 2, 3]);
  assert.deepEqual(missingBlocks(['2-3'], 4), [2, 3]);
  assert.deepEqual(missingBlocks(['1', '4-9'], 5), [1, 4, 5]);
  assert.deepEqual(missingBlocks(['nonsense'], 2), [1, 2]);
});

test('model tools post the documented request bodies', async () => {
  const bodies = {};
  const create = (name, id) => (_url, init) => { bodies[name] = JSON.parse(init.body); return [200, { c: '0', d: id }]; };
  const { impl } = mockFetch({
    [`POST ${BASE}/lux3d/v1/animations/rig/task/create`]: create('rig', 11),
    [`POST ${BASE}/lux3d/v1/animations/retarget/task/create`]: create('retarget', 12),
    [`POST ${BASE}/lux3d/v1/multi-format-export/task/create`]: create('export', 13),
    [`POST ${BASE}/lux3d/v1/part-split/task/create`]: create('split', 14),
    [`POST ${BASE}/lux3d/v1/generate/material-transfer/task/create`]: create('material', 15),
    [`POST ${BASE}/lux3d/v1/generate/multimodal-to-image/task/create`]: create('image', 16),
    [`POST ${BASE}/lux3d/v1/generate/image-to-four-view/task/create`]: create('fourView', 17),
    [`POST ${BASE}/lux3d/v1/articulation-animation/task/create`]: create('articulation', 18),
  });
  const lux = createLux3D({ apiKey: KEY, fetchImpl: impl });
  const m = 'https://cdn.example.com/m.glb';
  assert.equal(await lux.createHumanoidRig(m), '11');
  assert.equal(await lux.createAnimationRetarget(m, { inPlace: true }), '12');
  assert.equal(await lux.createMultiFormatExport(m, ['usdz', 'stl', 'usdz']), '13');
  assert.equal(await lux.createPartSplit(m), '14');
  assert.equal(await lux.createMaterialTransfer(m, 'https://cdn.example.com/ref.png'), '15');
  assert.equal(await lux.createMultimodalImage({ prompt: 'muddy car' }), '16');
  assert.equal(await lux.createFourView({ imageUrl: 'https://cdn.example.com/ref.png' }), '17');
  assert.equal(await lux.createArticulation(m, 'hinge the door'), '18');
  assert.deepEqual(bodies.rig, { modelUrl: m });
  assert.deepEqual(bodies.retarget, { rigModelUrl: m, animationIds: ['Walk_Loop'], animationOutputMode: 'separate', outFormat: 'glb', animateInPlace: true });
  assert.deepEqual(bodies.export, { modelUrl: m, outputFormat: ['usdz', 'stl'] });
  assert.deepEqual(bodies.split, { glbUrl: m });
  assert.deepEqual(bodies.material, { img: 'https://cdn.example.com/ref.png', meshUrl: m, version: 'v3.0-standard', outputFormat: ['glb'] });
  assert.deepEqual(bodies.image, { prompt: 'muddy car' });
  assert.deepEqual(bodies.fourView, { img: 'https://cdn.example.com/ref.png' });
  assert.deepEqual(bodies.articulation, { glbUrl: m, prompt: 'hinge the door' });
});

test('model tools reject bad input before spending credits', async () => {
  const lux = createLux3D({ apiKey: KEY, fetchImpl: async () => { throw new Error('should not be called'); } });
  await assert.rejects(lux.createMultiFormatExport('https://x.example/m.glb', []), Lux3DError);
  await assert.rejects(lux.createMultiFormatExport('https://x.example/m.glb', ['glb']), /Unsupported export format/);
  await assert.rejects(lux.createHumanoidRig('file:///etc/passwd'), /public http/);
  await assert.rejects(lux.createMultimodalImage({}), /prompt, an image/);
  await assert.rejects(lux.createArticulation('https://x.example/m.glb', '  '), /blank/);
  await assert.rejects(lux.createAnimationRetarget('https://x.example/m.glb', { animationIds: [] }), /between 1 and 10/);
});

test('a failed rig reports the error from its output JSON, without leaking the key', async () => {
  const { impl } = mockFetch({
    [`GET ${BASE}/lux3d/v1/generate/task/get`]: () => [200, {
      c: '0', m: '', d: { taskId: 9, status: 4, outputs: [{ content: `{"error":{"code":"MODEL_NOT_RIGGABLE","message":"Model does not meet rigging requirements ${KEY}"}}` }] },
    }],
  });
  const lux = createLux3D({ apiKey: KEY, fetchImpl: impl });
  const task = await lux.getTask('9');
  assert.equal(task.state, 'failed');
  assert.deepEqual(task.urls, []);
  assert.match(task.message, /MODEL_NOT_RIGGABLE: Model does not meet rigging requirements/);
  assert.ok(!task.message.includes(KEY));
  await assert.rejects(lux.waitForTask('9', { intervalMs: 1 }), /MODEL_NOT_RIGGABLE/);
});

test('retargetActions and outputError parse the retarget result JSON', () => {
  const ok = '{"actions":[{"animation_id":"Walk_Loop","status":"success","animationGlbUrl":"https://cdn.example.com/walk.glb"}]}';
  assert.deepEqual(retargetActions([ok]), [{ animationId: 'Walk_Loop', status: 'success', glbUrl: 'https://cdn.example.com/walk.glb', fbxUrl: null, error: '' }]);
  assert.deepEqual(extractOutputUrls([{ content: ok }]), []);
  const bad = '{"actions":[{"animation_id":"Swim_Fwd_Loop","status":"failed","error":{"code":"ANIMATION_RETARGET_FAILED","message":"retarget failed"}}]}';
  assert.equal(outputError([bad]), 'Swim_Fwd_Loop: ANIMATION_RETARGET_FAILED: retarget failed');
  assert.equal(outputError(['https://cdn.example.com/a.glb']), '');
});

test('exportUrls picks formats by suffix or position and skips NOT_REQUESTED', () => {
  const positional = ['https://c/in.zip', 'https://c/model.glb', 'https://c/RealityKitPreview.usdz', 'NOT_REQUESTED', 'NOT_REQUESTED', 'https://c/model.stl', 'NOT_REQUESTED'];
  assert.deepEqual(exportUrls(positional), { zip: 'https://c/in.zip', glb: 'https://c/model.glb', usdz: 'https://c/RealityKitPreview.usdz', stl: 'https://c/model.stl' });
  // No suffixes: fall back to the documented order.
  assert.equal(exportUrls(['', '', 'https://c/a', '', '', 'https://c/b', 'https://c/c'])['3mf'], 'https://c/c');
  assert.equal(exportUrls(['https://c/r.zip', 'https://c/t.glb', 'NOT_REQUESTED', 'NOT_REQUESTED', 'NOT_REQUESTED'], MATERIAL_TRANSFER_ORDER).glb, 'https://c/t.glb');
  assert.deepEqual(exportUrls(['https://c/x.usdz?sig=1']), { usdz: 'https://c/x.usdz?sig=1' });
});

test('looksLike checks magic bytes and the binary STL size rule', () => {
  const stl = Buffer.alloc(84 + 50 * 2);
  stl.writeUInt32LE(2, 80);
  assert.ok(looksLike('stl', stl));
  assert.ok(!looksLike('stl', Buffer.alloc(90)));
  assert.ok(looksLike('stl', Buffer.from('solid x\n facet normal 0 0 1\n')));
  assert.ok(looksLike('usdz', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0])));
  assert.ok(!looksLike('usdz', Buffer.from('glTF....')));
  assert.ok(looksLike('glb', Buffer.from('glTF\x02\0\0\0\0\0\0\0')));
  assert.ok(looksLike('image', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
});

test('downloadFile refuses files of the wrong type', async () => {
  const fetchImpl = async () => new Response('<html>nope</html>', { status: 200 });
  await assert.rejects(downloadFile('https://c/x.usdz', { kind: 'usdz', fetchImpl }), /not a valid usdz/);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const bytes = await downloadFile('https://c/x.usdz', { kind: 'usdz', fetchImpl: async () => new Response(zip) });
  assert.equal(bytes.length, zip.length);
});

// ---------- /api/export handlers ----------

test('resolveModelPath only allows .glb files under the models folder', () => {
  const root = path.resolve('/srv/public/models');
  assert.equal(resolveModelPath(root, '/models/library/family-suv.glb'), path.join(root, 'library', 'family-suv.glb'));
  for (const bad of ['/models/../server.mjs', '/models/library/../../x.glb', '/models/%2e%2e/x.glb', '/models\\library\\x.glb',
    '/models/library/x.glb/', 'models/library/x.glb', '/models/library/x.txt', '/models//x.glb', '/elsewhere/x.glb', '/models/./x.glb', null]) {
    assert.equal(resolveModelPath(root, bad), null, String(bad));
  }
});

function fakeRequest(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  return req;
}

async function call(handlers, method, target, body) {
  let reply;
  const sendJson = (_res, status, json) => { reply = { status, json }; };
  await handlers.handleExport(fakeRequest(method, body), {}, new URL(target, 'http://localhost'), sendJson);
  return reply;
}

test('POST/GET /api/export validates, starts one task, polls and saves the file', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'waterline-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const generatedDir = path.join(dir, 'models', 'generated');
  await mkdir(path.join(dir, 'models', 'library'), { recursive: true });
  await writeFile(path.join(dir, 'models', 'library', 'family-suv.glb'), 'glTF fake model');
  await writeFile(path.join(dir, 'secret.glb'), 'outside');

  const created = [];
  let state = 1;
  const lux = {
    uploadFile: async (bytes, name) => { assert.equal(name, 'family-suv.glb'); return 'https://cdn.example.com/up.glb'; },
    createMultiFormatExport: async (url, formats) => { created.push({ url, formats }); return '4242'; },
    getTask: async () => ({ state: state === 3 ? 'succeeded' : 'running', contents: state === 3 ? ['NOT_REQUESTED', 'NOT_REQUESTED', 'https://c/RealityKitPreview.usdz', 'NOT_REQUESTED', 'NOT_REQUESTED', 'NOT_REQUESTED', 'NOT_REQUESTED'] : [] }),
  };
  const usdz = Buffer.from([0x50, 0x4b, 0x03, 0x04, 9, 9]);
  const handlers = createExtrasHandlers({ lux, generatedDir, fetchImpl: async () => new Response(usdz) });

  assert.equal((await call(handlers, 'POST', '/api/export', { model: '/models/library/family-suv.glb', format: 'glb' })).status, 400);
  assert.equal((await call(handlers, 'POST', '/api/export', { model: '/models/../secret.glb', format: 'usdz' })).status, 400);
  assert.equal((await call(handlers, 'POST', '/api/export', { model: '/models/library/missing.glb', format: 'usdz' })).status, 404);
  assert.equal((await call(handlers, 'POST', '/api/export', 'not json')).status, 400);
  assert.equal((await call(handlers, 'DELETE', '/api/export')).status, 405);
  assert.equal(created.length, 0);

  const start = await call(handlers, 'POST', '/api/export', { model: '/models/library/family-suv.glb', format: 'usdz' });
  assert.deepEqual(start, { status: 200, json: { taskId: '4242' } });
  assert.deepEqual(created, [{ url: 'https://cdn.example.com/up.glb', formats: ['usdz'] }]);
  // The same request again reuses the task instead of paying twice.
  assert.deepEqual((await call(handlers, 'POST', '/api/export', { model: '/models/library/family-suv.glb', format: 'usdz' })).json, { taskId: '4242' });
  assert.equal(created.length, 1);

  assert.deepEqual((await call(handlers, 'GET', '/api/export?id=4242')).json, { state: 'running' });
  assert.equal((await call(handlers, 'GET', '/api/export?id=999')).status, 404);
  assert.equal((await call(handlers, 'GET', '/api/export?id=../x')).status, 400);
  state = 3;
  const finished = await call(handlers, 'GET', '/api/export?id=4242');
  assert.deepEqual(finished.json, { state: 'done', url: '/models/generated/exports/4242.usdz', format: 'usdz' });
  assert.deepEqual(await readFile(path.join(generatedDir, 'exports', '4242.usdz')), usdz);
});

test('/api/export is 503 without a Lux3D client', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'waterline-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handlers = createExtrasHandlers({ lux: null, generatedDir: path.join(dir, 'models', 'generated') });
  assert.equal((await call(handlers, 'POST', '/api/export', { model: '/models/library/a.glb', format: 'stl' })).status, 503);
});
