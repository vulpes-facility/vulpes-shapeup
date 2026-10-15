import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { bodyLimit, httpServer } from '../src/http.mjs';

async function serve(webhook, log = () => {}) {
  const server = httpServer({ webhook, log });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('the webhook gets the raw body and GitHub\'s headers, and its answer becomes the response', async () => {
  const seen = [];
  const { server, url } = await serve({ async handle(request) { seen.push(request); return { status: 202, message: 'Queued acme/game#11.' }; } });
  try {
    const response = await fetch(`${url}/webhook`, { method: 'POST', body: '{"a": 1}',
      headers: { 'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': 'd-1', 'X-Hub-Signature-256': 'sha256=ab' } });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { message: 'Queued acme/game#11.' });
    assert.deepEqual({ ...seen[0], body: seen[0].body.toString() }, { event: 'issues', delivery: 'd-1', signature: 'sha256=ab', body: '{"a": 1}' });
  } finally {
    server.close();
  }
});

test('the health check answers, other paths and methods do not reach the webhook', async () => {
  let calls = 0;
  const { server, url } = await serve({ async handle() { calls++; return { status: 200, message: '' }; } });
  try {
    const health = await fetch(`${url}/healthz`);
    assert.deepEqual([health.status, await health.json()], [200, { ok: true }]);
    assert.equal((await fetch(`${url}/webhook`)).status, 405);
    assert.equal((await fetch(`${url}/admin`)).status, 404);
    assert.equal(calls, 0);
  } finally {
    server.close();
  }
});

test('an oversized body is refused, and a failure logs only its code', async () => {
  const log = [];
  const { server, url } = await serve({ async handle() { const error = new Error('secret detail'); error.code = 'ECONNRESET'; throw error; } }, entry => log.push(entry));
  try {
    const big = await fetch(`${url}/webhook`, { method: 'POST', body: Buffer.alloc(bodyLimit + 1) }).catch(() => null);
    if (big) assert.equal(big.status, 413);
    const failed = await fetch(`${url}/webhook`, { method: 'POST', body: '{}' });
    assert.deepEqual([failed.status, await failed.json()], [500, { message: 'Internal error.' }]);
    assert.deepEqual(log, [{ level: 'error', event: 'request', code: 'ECONNRESET' }]);
  } finally {
    server.close();
  }
});
