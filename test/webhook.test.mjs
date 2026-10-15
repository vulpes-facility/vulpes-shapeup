import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { priorities } from '../src/queue.mjs';
import { WebhookHandler, validSignature } from '../src/webhook.mjs';

const secret = 'webhook-secret';
const sign = body => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

// In-memory stand-ins for the database classes, recording what the handler asks of them.
function fakes({ repositories = { 'acme/game': { installationId: 7, suspended: false } }, issue = null } = {}) {
  const calls = [];
  const seen = new Set();
  const deliveries = {
    async first(id) { if (seen.has(id)) return false; seen.add(id); return true; },
    async forget(id) { seen.delete(id); calls.push(['forget', id]); },
  };
  const queue = { async enqueue(job) { calls.push(['enqueue', job]); return true; } };
  const registry = {
    async repository(name) { return repositories[name] ? { fullName: name, ...repositories[name] } : null; },
    async upsertInstallation(installation) { calls.push(['upsert', installation]); },
    async addRepositories(id, names) { calls.push(['add', id, names]); return names.filter(name => !repositories[name]); },
    async removeRepositories(names) { calls.push(['remove', names]); },
    async removeInstallation(id) { calls.push(['removeInstallation', id]); },
  };
  const resolveIssue = async (installationId, nodeId) => { calls.push(['resolve', installationId, nodeId]); return issue; };
  return { calls, handler: new WebhookHandler({ secret, deliveries, queue, registry, resolveIssue }) };
}

let deliveryCount = 0;
function deliver(handler, event, payload, overrides = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  return handler.handle({ event, delivery: `d-${++deliveryCount}`, signature: sign(body), body, ...overrides });
}
const enqueued = calls => calls.filter(c => c[0] === 'enqueue').map(c => c[1]);
const repository = { full_name: 'acme/game' };
const scopeIssue = { number: 11, labels: [{ name: 'scope' }] };

test('the signature is checked over the raw body, in constant time, before anything else', async () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');
  assert.ok(validSignature(secret, body, sign(body)));
  for (const header of [undefined, '', 'sha1=abc', `${sign(body)}0`, sign(Buffer.from('{}')), sign(body).toUpperCase()]) {
    assert.ok(!validSignature(secret, body, header), String(header));
  }
  const f = fakes();
  assert.deepEqual(await f.handler.handle({ event: 'ping', delivery: 'x', signature: 'sha256=00', body }), { status: 401, message: 'The signature does not match.' });
  assert.deepEqual(await deliver(f.handler, 'ping', {}, { delivery: undefined }), { status: 400, message: 'The event or delivery header is missing.' });
  const bad = Buffer.from('{ nope');
  assert.deepEqual(await f.handler.handle({ event: 'ping', delivery: 'y', signature: sign(bad), body: bad }), { status: 400, message: 'The body is not JSON.' });
  assert.deepEqual(f.calls, []);
});

test('a repeated delivery is acted on once', async () => {
  const f = fakes();
  const body = Buffer.from(JSON.stringify({ action: 'opened', repository, issue: scopeIssue }));
  const first = await f.handler.handle({ event: 'issues', delivery: 'same', signature: sign(body), body });
  const second = await f.handler.handle({ event: 'issues', delivery: 'same', signature: sign(body), body });
  assert.equal(first.status, 202);
  assert.deepEqual(second, { status: 200, message: 'This delivery was already handled.' });
  assert.equal(enqueued(f.calls).length, 1);
});

test('a scope opening, closing or reopening, and a person\'s comment, queue the scope at event priority', async () => {
  for (const [event, payload] of [
    ['issues', { action: 'opened', repository, issue: scopeIssue }],
    ['issues', { action: 'closed', repository, issue: scopeIssue }],
    ['issues', { action: 'reopened', repository, issue: scopeIssue }],
    ['issue_comment', { action: 'created', repository, issue: scopeIssue, comment: { user: { type: 'User' } } }],
  ]) {
    const f = fakes();
    assert.deepEqual(await deliver(f.handler, event, payload), { status: 202, message: 'Queued acme/game#11.' }, `${event} ${payload.action}`);
    assert.deepEqual(enqueued(f.calls), [{ repository: 'acme/game', installationId: 7, kind: 'scope', number: 11, labels: ['scope'], priority: priorities.event }]);
  }
});

test('edits, pull request comments, bot comments, other events and repositories the App does not draw for queue nothing', async () => {
  for (const [event, payload, repositories] of [
    ['issues', { action: 'edited', repository, issue: scopeIssue }],
    ['issue_comment', { action: 'edited', repository, issue: scopeIssue, comment: { user: { type: 'User' } } }],
    ['issue_comment', { action: 'created', repository, issue: { ...scopeIssue, pull_request: {} }, comment: { user: { type: 'User' } } }],
    ['issue_comment', { action: 'created', repository, issue: scopeIssue, comment: { user: { type: 'Bot' } } }],
    ['push', { repository }],
    ['issues', { action: 'opened', repository: { full_name: 'acme/other' }, issue: scopeIssue }],
    ['issues', { action: 'opened', repository, issue: scopeIssue }, { 'acme/game': { installationId: 7, suspended: true } }],
  ]) {
    const f = fakes({ repositories });
    const result = await deliver(f.handler, event, payload);
    assert.equal(result.status, 200, `${event} ${payload.action}`);
    assert.deepEqual(enqueued(f.calls), [], `${event} ${payload.action}`);
  }
  assert.deepEqual(await deliver(fakes().handler, 'ping', { zen: 'x' }), { status: 200, message: 'pong' });
});

test('a board edit is traced to its issue and repository through GraphQL', async () => {
  const f = fakes({ issue: { repository: 'acme/game', number: 12, labels: ['scope'] } });
  const payload = { action: 'edited', installation: { id: 7 }, projects_v2_item: { content_type: 'Issue', content_node_id: 'I_kw12' } };
  assert.deepEqual(await deliver(f.handler, 'projects_v2_item', payload), { status: 202, message: 'Queued acme/game#12.' });
  assert.deepEqual(f.calls.find(c => c[0] === 'resolve'), ['resolve', 7, 'I_kw12']);
  assert.deepEqual(enqueued(f.calls)[0], { repository: 'acme/game', installationId: 7, kind: 'scope', number: 12, labels: ['scope'], priority: priorities.event });
  for (const other of [{ ...payload, action: 'created' }, { ...payload, projects_v2_item: { content_type: 'DraftIssue', content_node_id: 'D' } }]) {
    const g = fakes();
    assert.equal((await deliver(g.handler, 'projects_v2_item', other)).status, 200);
    assert.deepEqual(g.calls, []);
  }
  const unreadable = fakes({ issue: null });
  assert.deepEqual(await deliver(unreadable.handler, 'projects_v2_item', payload), { status: 200, message: 'Ignored: the item\'s issue cannot be read.' });
});

test('installations follow the App: new repositories get a rebuild, removed and deleted ones leave', async () => {
  const installation = { id: 9, account: { login: 'acme' }, suspended_at: null };
  const f = fakes({ repositories: {} });
  assert.deepEqual(await deliver(f.handler, 'installation', { action: 'created', installation, repositories: [{ full_name: 'acme/a' }, { full_name: 'acme/b' }] }),
    { status: 202, message: 'Added 2 repositories to installation 9.' });
  assert.deepEqual(f.calls.filter(c => c[0] !== 'enqueue'), [['upsert', { id: 9, account: 'acme', suspended: false }], ['add', 9, ['acme/a', 'acme/b']]]);
  assert.deepEqual(enqueued(f.calls), ['acme/a', 'acme/b'].map(name => ({ repository: name, installationId: 9, kind: 'all', priority: priorities.install })));

  const g = fakes({ repositories: {} });
  await deliver(g.handler, 'installation_repositories', { action: 'added', installation, repositories_added: [{ full_name: 'acme/c' }], repositories_removed: [] });
  await deliver(g.handler, 'installation_repositories', { action: 'removed', installation, repositories_added: [], repositories_removed: [{ full_name: 'acme/a' }] });
  await deliver(g.handler, 'installation', { action: 'suspend', installation: { ...installation, suspended_at: '2026-10-15T00:00:00Z' } });
  await deliver(g.handler, 'installation', { action: 'deleted', installation });
  assert.deepEqual(g.calls, [
    ['upsert', { id: 9, account: 'acme', suspended: false }], ['remove', []], ['add', 9, ['acme/c']],
    ['enqueue', { repository: 'acme/c', installationId: 9, kind: 'all', priority: priorities.install }],
    ['upsert', { id: 9, account: 'acme', suspended: false }], ['remove', ['acme/a']], ['add', 9, []],
    ['upsert', { id: 9, account: 'acme', suspended: true }],
    ['removeInstallation', 9],
  ]);
});

test('a delivery that fails half-way is forgotten, so GitHub\'s redelivery is acted on', async () => {
  const f = fakes();
  f.handler.queue.enqueue = async () => { throw new Error('connection lost'); };
  const body = Buffer.from(JSON.stringify({ action: 'opened', repository, issue: scopeIssue }));
  await assert.rejects(f.handler.handle({ event: 'issues', delivery: 'retry-me', signature: sign(body), body }), /connection lost/);
  assert.deepEqual(f.calls, [['forget', 'retry-me']]);
  f.handler.queue.enqueue = async () => true;
  assert.equal((await f.handler.handle({ event: 'issues', delivery: 'retry-me', signature: sign(body), body })).status, 202);
});
