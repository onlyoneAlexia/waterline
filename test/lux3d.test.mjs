import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLux3D, extractOutputUrls, Lux3DError } from '../lib/lux3d.mjs';

const KEY = 'secret-key-123';

function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const target = new URL(url);
    calls.push({ url: target, init });
    const handler = routes[`${init.method ?? 'GET'} ${target.origin}${target.pathname}`];
    if (!handler) throw new Error(`unexpected request ${init.method ?? 'GET'} ${target}`);
    const [status, body] = handler(target, init);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { impl, calls };
}

test('upload -> create -> poll flow follows the Lux3D contract', async () => {
  const base = 'https://api.aholo.ai/global';
  const ous = 'https://ous.example.com';
  let statusCalls = 0;
  const { impl, calls } = mockFetch({
    [`GET ${base}/asset/v1/token`]: () => [200, { c: '0', d: { ousToken: 'ous-tok', globalDomain: `${ous}/`, blockSize: 10_000_000 } }],
    [`POST ${ous}/ous/api/v2/single/upload`]: () => [200, { c: '0', d: { taskId: 7 } }],
    [`GET ${ous}/ous/api/v2/upload/status`]: () => [200, { c: '0', d: ++statusCalls < 2 ? { status: 1 } : { status: 5, url: 'https://cdn.example.com/photo.jpg', uploadKey: 'k' } }],
    [`POST ${base}/lux3d/v1/generate/img-to-3d/task/create`]: () => [200, { c: '0', d: 98765 }],
    [`GET ${base}/lux3d/v1/generate/task/get`]: () => [200, {
      c: '0',
      d: { taskId: 98765, status: 3, outputs: [{ content: '["https://cdn.example.com/a.zip","https://cdn.example.com/m.glb?sig=1"]' }] },
    }],
  });
  const lux = createLux3D({ apiKey: KEY, fetchImpl: impl });

  const imageUrl = await lux.uploadImage(Buffer.from('fake image bytes'), 'car.jpg');
  assert.equal(imageUrl, 'https://cdn.example.com/photo.jpg');

  const taskId = await lux.createImageTo3D(imageUrl);
  assert.equal(taskId, '98765');
  const create = calls.find((c) => c.url.pathname.endsWith('/img-to-3d/task/create'));
  assert.equal(create.init.headers.Authorization, KEY);
  assert.deepEqual(JSON.parse(create.init.body), {
    version: 'G1-Turbo', outputFormat: ['glb'], aiPredictSize: true, enablePbr: true, faceCount: 60_000, img: imageUrl,
  });

  const task = await lux.getTask(taskId);
  assert.equal(task.state, 'succeeded');
  assert.equal(task.glbUrl, 'https://cdn.example.com/m.glb?sig=1');
  const poll = calls.find((c) => c.url.pathname.endsWith('/task/get'));
  assert.equal(poll.url.searchParams.get('taskid'), '98765');
  const upload = calls.find((c) => c.url.pathname.endsWith('/single/upload'));
  assert.equal(upload.init.headers['ous-token-v2'], 'ous-tok');
});

test('business errors throw and never leak the API key', async () => {
  const { impl } = mockFetch({
    'POST https://api.aholo.ai/global/lux3d/v1/generate/text-to-3d/task/create': () => [200, { c: '40001', m: `bad key ${KEY}` }],
  });
  const lux = createLux3D({ apiKey: KEY, fetchImpl: impl });
  await assert.rejects(lux.createTextTo3D('a red car'), (error) => {
    assert.ok(error instanceof Lux3DError);
    assert.match(error.message, /40001/);
    assert.ok(!error.message.includes(KEY));
    return true;
  });
});

test('status checks survive a network blip and a 502', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    if (calls === 2) return new Response('{}', { status: 502 });
    return new Response(JSON.stringify({ c: '0', d: { taskId: 5, status: 1, outputs: [] } }), { status: 200 });
  };
  const lux = createLux3D({ apiKey: KEY, fetchImpl, retryDelayMs: 1 });
  const task = await lux.getTask('5');
  assert.equal(task.state, 'running');
  assert.equal(calls, 3);
});

test('creating a task is never retried (it might already exist)', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  };
  const lux = createLux3D({ apiKey: KEY, fetchImpl, retryDelayMs: 1 });
  await assert.rejects(lux.createTextTo3D('a red car'), Lux3DError);
  assert.equal(calls, 1);
});

test('extractOutputUrls skips NOT_REQUESTED and flattens JSON arrays', () => {
  assert.deepEqual(
    extractOutputUrls([{ content: 'NOT_REQUESTED' }, { content: '["a","b"]' }, { content: 'c' }, { content: null }]),
    ['a', 'b', 'c'],
  );
});

test('refuses to start without an API key', () => {
  assert.throws(() => createLux3D({ apiKey: '' }), /LUX3D_API_KEY/);
});
