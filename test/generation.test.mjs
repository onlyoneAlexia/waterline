import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';

test('generation validates input, enforces quota, resumes after restart and deduplicates downloads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'waterline-generation-'));
  let server;
  let polls = 0, downloads = 0;
  const options = {
    generatedDir: path.join(root, 'models'), tasksDir: path.join(root, 'tasks'),
    luxClient: {
      createTextTo3D: async () => '123456789',
      getTask: async () => { polls++; await new Promise(r => setTimeout(r, 20)); return { state: 'succeeded', glbUrl: 'https://example.invalid/model.glb' }; },
    },
    downloadModel: async () => { downloads++; return Buffer.from('glTFtest-model'); },
  };
  const start = async () => {
    server = createAppServer({ MAX_GENERATIONS_PER_DAY: '1' }, options);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { await new Promise(r => server.close(r)); server = null; };
  try {
    let base = await start();
    for (const body of ['null', '[]', '{}', '{"prompt":"car","image":"bad"}']) {
      const response = await fetch(`${base}/api/generate`, { method: 'POST', body });
      assert.equal(response.status, 400); await response.text();
    }
    const created = await fetch(`${base}/api/generate`, { method: 'POST', body: JSON.stringify({ prompt: 'a car', name: 'Test car' }) });
    assert.equal(created.status, 200); assert.equal((await created.json()).taskId, '123456789');
    const quota = await fetch(`${base}/api/generate`, { method: 'POST', body: '{"prompt":"another car"}' });
    assert.equal(quota.status, 429); await quota.text();
    await stop(); base = await start();
    const results = await Promise.all([1, 2].map(async () => (await fetch(`${base}/api/task?id=123456789`)).json()));
    assert.ok(results.every(result => result.state === 'done'));
    assert.equal(polls, 1); assert.equal(downloads, 1);
    assert.equal((await readFile(path.join(root, 'models', '123456789.glb'))).toString(), 'glTFtest-model');
    const completed = await (await fetch(`${base}/api/task?id=123456789`)).json();
    assert.equal(completed.state, 'done'); assert.equal(downloads, 1);
  } finally {
    if (server) await stop();
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'waterline-generation-'));
    await rm(root, { recursive: true, force: true });
  }
});
