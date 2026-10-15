import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ShapeUpError } from 'gh-vulpes-shapeup/domain';

const fail = message => { throw new ShapeUpError('settings', message); };

// A secret comes from a file, so that a deployment can mount it. No message repeats what the file holds.
async function secret(env, name, { required = true } = {}) {
  const path = (env[name] ?? '').trim();
  if (!path) {
    if (required) fail(`${name} must name a file.`);
    return null;
  }
  let text;
  try { text = await readFile(path, 'utf8'); } catch { fail(`${name} names a file that cannot be read.`); }
  const value = text.trim();
  if (!value) fail(`${name} names an empty file.`);
  return value;
}

function port(env) {
  const text = (env.SHAPEUP_PORT ?? '').trim() || '8080';
  if (!/^[1-9][0-9]{0,4}$/.test(text) || Number(text) > 65_535) fail('SHAPEUP_PORT must be a port from 1 to 65535.');
  return Number(text);
}

function apiUrl(env) {
  const text = (env.SHAPEUP_GITHUB_API_URL ?? '').trim() || 'https://api.github.com';
  let url;
  try { url = new URL(text); } catch { fail('SHAPEUP_GITHUB_API_URL must be a URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.search || url.hash) fail('SHAPEUP_GITHUB_API_URL must be an http or https URL with no query.');
  return text.replace(/\/+$/, '');
}

// Reads everything that belongs to one organization from the environment; the server does not start without it.
export async function loadSettings(env = process.env) {
  const clientId = (env.SHAPEUP_APP_CLIENT_ID ?? '').trim();
  if (!clientId) fail('SHAPEUP_APP_CLIENT_ID must hold the App\'s Client ID.');
  const privateKey = await secret(env, 'SHAPEUP_APP_PRIVATE_KEY_FILE');
  try { createPrivateKey(privateKey); } catch { fail('SHAPEUP_APP_PRIVATE_KEY_FILE does not hold a PEM private key.'); }
  const databaseUrl = await secret(env, 'SHAPEUP_DATABASE_URL_FILE');
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) fail('SHAPEUP_DATABASE_URL_FILE must hold a postgres:// connection string.');
  return {
    port: port(env),
    apiUrl: apiUrl(env),
    clientId,
    privateKey,
    webhookSecret: await secret(env, 'SHAPEUP_WEBHOOK_SECRET_FILE'),
    databaseUrl,
    rebuildSchedule: (env.SHAPEUP_REBUILD_SCHEDULE ?? '').trim() || '0 * * * *',
    syncSchedule: (env.SHAPEUP_SYNC_SCHEDULE ?? '').trim() || '0 */4 * * *',
    adminToken: await secret(env, 'SHAPEUP_ADMIN_TOKEN_FILE', { required: false }),
  };
}
