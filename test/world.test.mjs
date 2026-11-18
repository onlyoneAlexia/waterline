import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';
import { createLux3D } from '../lib/lux3d.mjs';

test('Aholo World rooms: validation, create, progress, download once, resume after restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'waterline-world-'));
  let server;
  let status = 'RUNNING';
  let downloads = 0;
  const created = [];
  const options = {
    worldsDir: path.join(root, 'worlds'), tasksDir: path.join(root, 'tasks'),
    luxClient: {
      uploadImage: async (bytes) => { assert.ok(bytes.length > 0); return 'https://ous.invalid/photo.jpg'; },
      createWorld: async (args) => { created.push(args); return 'AbC123xyz'; },
      getWorld: async () => (status === 'SUCCEEDED'
        ? { state: 'succeeded', spzUrl: 'https://cos.invalid/room.spz', upAxis: 'Z' }
        : { state: 'running', progress: 0.4 }),
    },
    fetchImpl: async (url) => { downloads++; assert.equal(String(url), 'https://cos.invalid/room.spz'); return new Response('SPZ-bytes'); },
  };
  const start = async () => {
    server = createAppServer({}, options);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { await new Promise((r) => server.close(r)); server = null; };
  try {
    let base = await start();
    for (const body of ['null', '[]', '{}', '{"image":"not-a-photo"}', JSON.stringify({ prompt: 'x'.repeat(301) })]) {
      const response = await fetch(`${base}/api/world`, { method: 'POST', body });
      assert.equal(response.status, 400, body.slice(0, 30)); await response.text();
    }
    assert.equal((await fetch(`${base}/api/world?id=../../x`)).status, 400);
    const photo = `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`;
    const response = await fetch(`${base}/api/world`, { method: 'POST', body: JSON.stringify({ image: photo, prompt: 'a kitchen' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).worldId, 'AbC123xyz');
    assert.deepEqual(created[0], { prompt: 'a kitchen', imageUrl: 'https://ous.invalid/photo.jpg', name: 'Waterline room' });
    const running = await (await fetch(`${base}/api/world?id=AbC123xyz`)).json();
    assert.deepEqual(running, { state: 'running', progress: 0.4 });

    // After a restart the room is still known, and the finished file is downloaded exactly once.
    await stop(); base = await start();
    status = 'SUCCEEDED';
    const results = await Promise.all([1, 2].map(async () => (await fetch(`${base}/api/world?id=AbC123xyz`)).json()));
    assert.ok(results.every((r) => r.state === 'done' && r.url === '/models/worlds/AbC123xyz.spz' && r.upAxis === 'Z'));
    assert.equal(downloads, 1);
    assert.equal((await readFile(path.join(root, 'worlds', 'AbC123xyz.spz'))).toString(), 'SPZ-bytes');
    assert.equal((await (await fetch(`${base}/api/world?id=AbC123xyz`)).json()).state, 'done');
    assert.equal(downloads, 1);
    assert.equal((await fetch(`${base}/api/world?id=Unknown99`)).status, 404);
  } finally {
    if (server) await stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Aholo World client sends the documented request and reads the result', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, auth: init.headers.Authorization, body: init.body && JSON.parse(init.body) });
    if (init.method === 'POST') return Response.json({ worldId: 'W0rld42' });
    return Response.json({ worldId: 'W0rld42', status: 'SUCCEEDED', progress: 1, assets: { splats: { urls: { spzPath: 'https://cos.invalid/a.spz', plyPath: 'https://cos.invalid/a.ply' } }, semanticsMetadata: { upAxis: 'Y' } } });
  };
  const lux = createLux3D({ apiKey: 'secret-key', fetchImpl });
  assert.equal(await lux.createWorld({ prompt: 'a hallway', imageUrl: 'https://ous.invalid/p.jpg' }), 'W0rld42');
  assert.deepEqual(calls[0], { url: 'https://api.aholo.ai/global/world/v1/generations', method: 'POST', auth: 'secret-key', body: { name: 'Waterline room', prompt: 'a hallway', resources: [{ url: 'https://ous.invalid/p.jpg', type: 'image' }] } });
  const world = await lux.getWorld('W0rld42');
  assert.equal(calls[1].url, 'https://api.aholo.ai/global/world/v1/W0rld42');
  assert.equal(world.state, 'succeeded');
  assert.equal(world.spzUrl, 'https://cos.invalid/a.spz');
  assert.equal(world.upAxis, 'Y');
  await assert.rejects(lux.createWorld({}), /description or a photo/);
});
