import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { AppAuth, appJwt, jobPermissions } from '../src/app-auth.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

// A fake GitHub that records each call with the bearer it carried.
function fake(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const call = { path: new URL(url).pathname + new URL(url).search, method: options.method,
      bearer: options.headers.Authorization.replace('Bearer ', ''), body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchImpl };
}

test('the JWT is RS256, issued by the Client ID, back-dated a minute and valid for nine', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  const [header, claims, signature] = appJwt('Iv23liTEST', pem, now).split('.');
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decode(claims), { iat: now / 1000 - 60, exp: now / 1000 + 540, iss: 'Iv23liTEST' });
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url'));
});

test('a job token is narrowed to its repository and permissions, and reused until five minutes before it expires', async () => {
  let now = Date.parse('2026-10-15T10:00:00Z');
  let minted = 0;
  const g = fake(call => response({ token: `token-${++minted}`, expires_at: new Date(now + 60 * 60_000).toISOString() }, 201));
  const auth = new AppAuth({ clientId: 'Iv23liTEST', privateKey: pem, fetchImpl: g.fetchImpl, now: () => now });
  const api = await auth.github(42, 'acme/game');
  assert.equal(api.repository, 'acme/game');
  assert.equal(api.repositoryToken, 'token-1');
  assert.equal(api.projectToken, 'token-1');
  assert.deepEqual(g.calls.map(c => [c.method, c.path, c.body]), [
    ['POST', '/app/installations/42/access_tokens', { repositories: ['game'], permissions: jobPermissions }]]);
  assert.equal(decode(g.calls[0].bearer.split('.')[1]).iss, 'Iv23liTEST');
  now += 54 * 60_000;
  assert.equal(await auth.token(42, 'acme/game'), 'token-1');
  now += 2 * 60_000;
  assert.equal(await auth.token(42, 'acme/game'), 'token-2');
  assert.equal(await auth.token(42, 'acme/other'), 'token-3');
  assert.deepEqual(jobPermissions, { contents: 'write', issues: 'write', organization_projects: 'read' });
});

test('installations and their repositories are read page by page', async () => {
  const many = (prefix, count) => Array.from({ length: count }, (_, i) => ({ id: i, full_name: `${prefix}/${i}` }));
  const g = fake(call => {
    if (call.path.startsWith('/app/installations?')) return response(call.path.endsWith('page=1') ? many('i', 100) : many('i', 3));
    if (call.path === '/app/installations/7/access_tokens') return response({ token: 'metadata-token', expires_at: '2099-01-01T00:00:00Z' }, 201);
    if (call.path.startsWith('/installation/repositories?')) return response({ repositories: call.path.endsWith('page=1') ? many('acme', 100) : many('acme', 1) });
    throw new Error(`Unexpected ${call.path}`);
  });
  const auth = new AppAuth({ clientId: 'Iv23liTEST', privateKey: pem, fetchImpl: g.fetchImpl });
  assert.equal((await auth.installations()).length, 103);
  assert.equal((await auth.repositories(7)).length, 101);
  const tokenCall = g.calls.find(c => c.path === '/app/installations/7/access_tokens');
  assert.deepEqual(tokenCall.body, { permissions: { metadata: 'read' } });
  assert.ok(g.calls.filter(c => c.path.startsWith('/installation/')).every(c => c.bearer === 'metadata-token'));
});

test('a refused token request names no response and no secret', async () => {
  const g = fake(() => response({ message: 'Bad credentials', token: 'leaked' }, 401));
  const auth = new AppAuth({ clientId: 'Iv23liTEST', privateKey: pem, fetchImpl: g.fetchImpl });
  await assert.rejects(auth.token(1, 'acme/game'), error => {
    assert.equal(error.code, 'api');
    assert.match(error.message, /HTTP 401/);
    assert.ok(!/Bad credentials|leaked|PRIVATE KEY/.test(error.message));
    return true;
  });
});
