import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { start } from '../src/main.mjs';

// The whole process against a fake GitHub on a local port and a throwaway PostgreSQL.
const url = process.env.SHAPEUP_TEST_DATABASE_URL;
const skip = url ? false : 'SHAPEUP_TEST_DATABASE_URL is not set';

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function freePort() {
  const server = await listen(() => {});
  const { port } = server.address();
  server.close();
  return port;
}

test('the server syncs at start, runs the jobs it queues, takes signed webhooks and stops cleanly', { skip }, async () => {
  const requests = [];
  const github = await listen((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.url.startsWith('/app/installations?')) return json(200, [{ id: 5, account: { login: 'acme' }, suspended_at: null }]);
    if (request.url === '/app/installations/5/access_tokens') return json(201, { token: 'ghs_fake', expires_at: '2099-01-01T00:00:00Z' });
    if (request.url.startsWith('/installation/repositories?')) return json(200, { repositories: [{ full_name: 'acme/game' }] });
    if (request.url === '/repos/acme/game/contents/.github/shapeup.json') return json(404, { message: 'Not Found' });
    json(500, { message: 'unexpected' });
  });
  const dir = await mkdtemp(join(tmpdir(), 'shapeup-main-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const files = { key: privateKey.export({ type: 'pkcs1', format: 'pem' }), secret: 'main-webhook-secret', db: url };
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  const port = await freePort();
  const env = { SHAPEUP_PORT: String(port), SHAPEUP_GITHUB_API_URL: `http://127.0.0.1:${github.address().port}`, SHAPEUP_APP_CLIENT_ID: 'Iv23liMAIN',
    SHAPEUP_APP_PRIVATE_KEY_FILE: join(dir, 'key'), SHAPEUP_WEBHOOK_SECRET_FILE: join(dir, 'secret'), SHAPEUP_DATABASE_URL_FILE: join(dir, 'db') };

  const log = [];
  const pool = (await import('../src/db.mjs')).createPool(url);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.end();
  const app = await start(env, { log: entry => log.push(entry) });
  try {
    let recorded = null;
    for (let i = 0; i < 100 && !recorded; i++) {
      const { rows } = await app.pool.query(`SELECT config_state, last_result FROM repository WHERE full_name = 'acme/game' AND last_result IS NOT NULL`);
      recorded = rows[0];
      if (!recorded) await sleep(50);
    }
    assert.deepEqual(recorded, { config_state: 'missing', last_result: 'skipped' });

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    const body = JSON.stringify({ zen: 'Design for failure.' });
    const ping = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', body, headers: {
      'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': 'main-1',
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', files.secret).update(body).digest('hex')}` } });
    assert.deepEqual([ping.status, await ping.json()], [200, { message: 'pong' }]);
    const forged = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', body, headers: { 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': 'main-2', 'X-Hub-Signature-256': 'sha256=00' } });
    assert.equal(forged.status, 401);
  } finally {
    await app.stop();
    github.close();
  }
  assert.ok(requests.includes('POST /app/installations/5/access_tokens'));
  assert.deepEqual(log.map(e => e.event).filter(e => ['listening', 'stopping', 'stopped'].includes(e)), ['listening', 'stopping', 'stopped']);
  const text = JSON.stringify(log);
  for (const secret of ['ghs_fake', 'main-webhook-secret', 'PRIVATE KEY']) assert.ok(!text.includes(secret), secret);
});
