import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings } from '../src/settings.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });

async function files(contents) {
  const dir = await mkdtemp(join(tmpdir(), 'shapeup-settings-'));
  const paths = {};
  for (const [name, text] of Object.entries(contents)) {
    paths[name] = join(dir, name);
    await writeFile(paths[name], text);
  }
  return paths;
}

async function environment(overrides = {}) {
  const f = await files({ key: pem, secret: 'webhook-secret\n', db: 'postgres://u:database-password@db/shapeup\n', admin: 'admin-token' });
  return { SHAPEUP_APP_CLIENT_ID: 'Iv23liTEST', SHAPEUP_APP_PRIVATE_KEY_FILE: f.key,
    SHAPEUP_WEBHOOK_SECRET_FILE: f.secret, SHAPEUP_DATABASE_URL_FILE: f.db, ...overrides };
}

test('the settings come from the environment, with defaults, and secrets from files', async () => {
  const settings = await loadSettings(await environment());
  assert.deepEqual({ ...settings, privateKey: settings.privateKey.length > 0 }, {
    port: 8080, apiUrl: 'https://api.github.com', clientId: 'Iv23liTEST', privateKey: true,
    webhookSecret: 'webhook-secret', databaseUrl: 'postgres://u:database-password@db/shapeup',
    databasePassword: null, rebuildSchedule: '0 * * * *', syncSchedule: '0 */4 * * *', adminToken: null,
  });
  const custom = await loadSettings(await environment({ SHAPEUP_PORT: '3000', SHAPEUP_GITHUB_API_URL: 'http://localhost:9000/api/v3/',
    SHAPEUP_REBUILD_SCHEDULE: '*/30 * * * *', SHAPEUP_ADMIN_TOKEN_FILE: (await files({ admin: ' admin-token\n' })).admin }));
  assert.equal(custom.port, 3000);
  assert.equal(custom.apiUrl, 'http://localhost:9000/api/v3');
  assert.equal(custom.rebuildSchedule, '*/30 * * * *');
  assert.equal(custom.adminToken, 'admin-token');
});

test('the database may come as a string without its password and the password in a file of its own', async () => {
  const f = await files({ password: 'database-password\n' });
  const settings = await loadSettings(await environment({ SHAPEUP_DATABASE_URL_FILE: '', SHAPEUP_DATABASE_URL: 'postgres://shapeup@postgres:5432/shapeup',
    SHAPEUP_DATABASE_PASSWORD_FILE: f.password }));
  assert.equal(settings.databaseUrl, 'postgres://shapeup@postgres:5432/shapeup');
  assert.equal(settings.databasePassword, 'database-password');
  const trusted = await loadSettings(await environment({ SHAPEUP_DATABASE_URL_FILE: '', SHAPEUP_DATABASE_URL: 'postgresql://shapeup@postgres/shapeup' }));
  assert.equal(trusted.databasePassword, null);
  for (const [overrides, message] of [
    [{ SHAPEUP_DATABASE_URL: 'postgres://shapeup@postgres/shapeup' }, 'Set SHAPEUP_DATABASE_URL or SHAPEUP_DATABASE_URL_FILE, not both.'],
    [{ SHAPEUP_DATABASE_URL_FILE: '', SHAPEUP_DATABASE_URL: 'postgres://shapeup:database-password@postgres/shapeup' },
      'SHAPEUP_DATABASE_URL must not hold a password; put it in SHAPEUP_DATABASE_PASSWORD_FILE.'],
    [{ SHAPEUP_DATABASE_URL_FILE: '', SHAPEUP_DATABASE_URL: 'mysql://shapeup@db/x' }, 'SHAPEUP_DATABASE_URL must be a postgres:// connection string.'],
    [{ SHAPEUP_DATABASE_PASSWORD_FILE: f.password }, 'SHAPEUP_DATABASE_PASSWORD_FILE goes with SHAPEUP_DATABASE_URL, not with SHAPEUP_DATABASE_URL_FILE.'],
  ]) {
    await assert.rejects(loadSettings(await environment(overrides)), error => {
      assert.equal(error.message, message);
      assert.ok(!error.message.includes('database-password'));
      return true;
    }, message);
  }
});

test('a missing or invalid setting stops the start, and no message repeats a secret', async () => {
  const bad = await files({ empty: '  \n', notKey: 'not a key', notDb: 'mysql://u:database-password@db/x' });
  for (const [overrides, message] of [
    [{ SHAPEUP_APP_CLIENT_ID: ' ' }, 'SHAPEUP_APP_CLIENT_ID must hold the App\'s Client ID.'],
    [{ SHAPEUP_APP_PRIVATE_KEY_FILE: '' }, 'SHAPEUP_APP_PRIVATE_KEY_FILE must name a file.'],
    [{ SHAPEUP_APP_PRIVATE_KEY_FILE: join(tmpdir(), 'no-such-shapeup-key.pem') }, 'SHAPEUP_APP_PRIVATE_KEY_FILE names a file that cannot be read.'],
    [{ SHAPEUP_APP_PRIVATE_KEY_FILE: bad.notKey }, 'SHAPEUP_APP_PRIVATE_KEY_FILE does not hold a PEM private key.'],
    [{ SHAPEUP_WEBHOOK_SECRET_FILE: bad.empty }, 'SHAPEUP_WEBHOOK_SECRET_FILE names an empty file.'],
    [{ SHAPEUP_DATABASE_URL_FILE: bad.notDb }, 'SHAPEUP_DATABASE_URL_FILE must hold a postgres:// connection string.'],
    [{ SHAPEUP_PORT: '0' }, 'SHAPEUP_PORT must be a port from 1 to 65535.'],
    [{ SHAPEUP_PORT: '65536' }, 'SHAPEUP_PORT must be a port from 1 to 65535.'],
    [{ SHAPEUP_GITHUB_API_URL: 'ftp://example.com' }, 'SHAPEUP_GITHUB_API_URL must be an http or https URL with no query.'],
    [{ SHAPEUP_GITHUB_API_URL: 'not a url' }, 'SHAPEUP_GITHUB_API_URL must be a URL.'],
    [{ SHAPEUP_REBUILD_SCHEDULE: '@hourly' }, 'SHAPEUP_REBUILD_SCHEDULE: "@hourly" must have five fields: minute, hour, day of month, month, day of week.'],
    [{ SHAPEUP_SYNC_SCHEDULE: '0 24 * * *' }, 'SHAPEUP_SYNC_SCHEDULE: The hour field "24" is outside 0-23.'],
  ]) {
    await assert.rejects(loadSettings(await environment(overrides)), error => {
      assert.equal(error.code, 'settings');
      assert.equal(error.message, message);
      assert.ok(!/database-password|webhook-secret|not a key/.test(error.message));
      return true;
    }, message);
  }
});
