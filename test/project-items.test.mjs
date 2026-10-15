import test from 'node:test';
import assert from 'node:assert/strict';
import { itemPermissions, resolveIssue } from '../src/project-items.mjs';

const response = body => new Response(JSON.stringify(body), { status: 200 });

function auth(answer) {
  const calls = [];
  return {
    calls,
    apiUrl: 'https://api.github.com',
    async token(installationId, repository, permissions) { calls.push(['token', installationId, repository, permissions]); return 'item-token'; },
    async fetch(url, options) { calls.push(['fetch', new URL(url).pathname, options.headers.Authorization, JSON.parse(options.body).variables]); return response(answer); },
  };
}

test('an item\'s content node is read as an issue with its repository and labels, on an installation-wide read token', async () => {
  const a = auth({ data: { node: { number: 12, repository: { nameWithOwner: 'acme/game' }, labels: { nodes: [{ name: 'scope' }, { name: 'ui' }] } } } });
  assert.deepEqual(await resolveIssue(a, 7, 'I_kw12'), { repository: 'acme/game', number: 12, labels: ['scope', 'ui'] });
  assert.deepEqual(a.calls, [['token', 7, null, itemPermissions], ['fetch', '/graphql', 'Bearer item-token', { id: 'I_kw12' }]]);
  assert.deepEqual(itemPermissions, { organization_projects: 'read', issues: 'read' });
});

test('content that is not a readable issue resolves to nothing', async () => {
  assert.equal(await resolveIssue(auth({ data: { node: {} } }), 7, 'PR_1'), null);
  assert.equal(await resolveIssue(auth({ data: { node: null }, errors: [{ type: 'NOT_FOUND' }] }), 7, 'I_gone'), null);
});
