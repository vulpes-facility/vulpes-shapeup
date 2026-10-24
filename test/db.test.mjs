import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPool, migrate, migrations, startWaitMs, waitForDatabase } from '../src/db.mjs';
import { Deliveries, Queue, priorities } from '../src/queue.mjs';
import { Registry } from '../src/registry.mjs';

// These run against a real PostgreSQL, since the claim's locking cannot be faked faithfully.
// The database is emptied first, so point SHAPEUP_TEST_DATABASE_URL only at a throwaway one.
const url = process.env.SHAPEUP_TEST_DATABASE_URL;
const skip = url ? false : 'SHAPEUP_TEST_DATABASE_URL is not set';

let pool;
async function fresh() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  return { queue: new Queue(pool), deliveries: new Deliveries(pool), registry: new Registry(pool) };
}
const job = (repository, kind, number, priority, labels = null) => ({ repository, installationId: 1, kind, number, labels, priority });
const states = async () => (await pool.query('SELECT repository, kind, number, state, result, error_code FROM job ORDER BY id')).rows;

test.before(() => { if (url) pool = createPool(url); });
test.after(async () => { await pool?.end(); });

test('the password may come apart from the connection string', { skip }, async () => {
  const parts = new URL(url);
  const password = decodeURIComponent(parts.password);
  parts.password = '';
  const apart = createPool(parts.toString(), password);
  try {
    assert.equal((await apart.query('SELECT 1 AS one')).rows[0].one, 1);
  } finally {
    await apart.end();
  }
});

// A pool whose connect fails with each error in turn and then succeeds, and a clock that only sleeping moves.
function waiting(errors) {
  const clock = { now: 0, slept: [], log: [] };
  const pool = { async connect() { if (errors.length) throw errors.shift(); return { release() {} }; } };
  const options = { log: entry => clock.log.push(entry), sleep: async ms => { clock.slept.push(ms); clock.now += ms; }, now: () => clock.now };
  return { pool, options, clock };
}
const networkError = code => Object.assign(new Error(`connect ${code}`), { code });
const databaseError = code => Object.assign(new pg.DatabaseError('refused', 0, 'error'), { code });

test('the server waits for a PostgreSQL that is still starting, longer after each failure', async () => {
  const { pool, options, clock } = waiting([networkError('ENOTFOUND'), networkError('ECONNREFUSED'), databaseError('57P03')]);
  assert.equal(await waitForDatabase(pool, options), 4);
  assert.deepEqual(clock.slept, [1_000, 2_000, 4_000]);
  assert.deepEqual(clock.log.map(entry => [entry.event, entry.code, entry.attempt]), [['database', 'ENOTFOUND', 1], ['database', 'ECONNREFUSED', 2], ['database', '57P03', 3]]);
});

test('the server stops waiting for PostgreSQL after startWaitMs and fails with the last error', async () => {
  const last = networkError('ECONNREFUSED');
  const { pool, options, clock } = waiting([]);
  pool.connect = async () => { throw last; };
  await assert.rejects(waitForDatabase(pool, options), error => error === last);
  assert.equal(clock.slept.reduce((sum, ms) => sum + ms, 0), startWaitMs);
  assert.deepEqual(clock.slept.slice(0, 5), [1_000, 2_000, 4_000, 8_000, 15_000]);
});

test('an error that PostgreSQL returns, such as a wrong password, ends the wait at once', async () => {
  const { pool, options, clock } = waiting([databaseError('28P01')]);
  await assert.rejects(waitForDatabase(pool, options), { code: '28P01' });
  assert.deepEqual(clock.slept, []);
});

test('a real PostgreSQL that refuses the password ends the wait at once', { skip }, async () => {
  const parts = new URL(url);
  parts.password = 'not-the-password';
  const wrong = createPool(parts.toString());
  try {
    await assert.rejects(waitForDatabase(wrong, { sleep: async () => assert.fail('it should not wait') }), { code: '28P01' });
  } finally {
    await wrong.end();
  }
});

test('migrations run once, in order, and a second run applies none', { skip }, async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  assert.equal(await migrate(pool), migrations.length);
  assert.equal(await migrate(pool), 0);
  const { rows } = await pool.query('SELECT version FROM migration ORDER BY version');
  assert.deepEqual(rows.map(row => row.version), migrations.map((_, i) => i + 1));
});

test('a repository has one pending job per kind and number, at the higher priority', { skip }, async () => {
  const { queue } = await fresh();
  assert.equal(await queue.enqueue(job('acme/a', 'all', null, priorities.schedule)), true);
  assert.equal(await queue.enqueue(job('acme/a', 'all', null, priorities.install)), false);
  assert.equal(await queue.enqueue(job('acme/a', 'scope', 11, priorities.event, ['scope'])), true);
  assert.equal(await queue.enqueue(job('acme/a', 'scope', 11, priorities.event, ['scope', 'ui'])), false);
  assert.equal(await queue.enqueue(job('acme/a', 'scope', 12, priorities.event)), true);
  const { rows } = await pool.query('SELECT kind, number, priority, labels FROM job ORDER BY id');
  assert.deepEqual(rows, [
    { kind: 'all', number: null, priority: priorities.install, labels: null },
    { kind: 'scope', number: 11, priority: priorities.event, labels: ['scope', 'ui'] },
    { kind: 'scope', number: 12, priority: priorities.event, labels: null },
  ]);
});

test('claims follow priority, and a repository never runs two jobs at once', { skip }, async () => {
  const { queue } = await fresh();
  await queue.enqueue(job('acme/a', 'all', null, priorities.schedule));
  await queue.enqueue(job('acme/b', 'all', null, priorities.schedule));
  await queue.enqueue(job('acme/a', 'scope', 11, priorities.event, ['scope']));
  const first = await queue.claim();
  assert.deepEqual({ ...first, id: undefined }, { id: undefined, repository: 'acme/a', installationId: 1, kind: 'scope', number: 11, labels: ['scope'], attempts: 1 });
  assert.equal((await queue.claim()).repository, 'acme/b');
  assert.equal(await queue.claim(), null);
  await queue.finish(first.id, 'drawn #10');
  const next = await queue.claim();
  assert.deepEqual([next.repository, next.kind], ['acme/a', 'all']);
});

test('two workers claiming at once never take two jobs of one repository', { skip }, async () => {
  const { queue } = await fresh();
  for (const number of [1, 2, 3, 4]) await queue.enqueue(job('acme/a', 'scope', number, priorities.event));
  const claims = await Promise.all([queue.claim(), queue.claim(), queue.claim(), queue.claim()]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await queue.counts()).running, 1);
});

test('a failure is retried after its delay, fails when no retry is left, and gives way to a newer job', { skip }, async () => {
  const { queue } = await fresh();
  await queue.enqueue(job('acme/a', 'scope', 11, priorities.event));
  const claimed = await queue.claim();
  assert.equal(await queue.fail(claimed.id, 'network', { retryIn: 60_000 }), 'retry');
  assert.equal(await queue.claim(), null);
  await pool.query(`UPDATE job SET available_at = now() - interval '1 second'`);
  const again = await queue.claim();
  assert.equal(again.attempts, 2);
  assert.equal(await queue.fail(again.id, 'api'), 'failed');

  await queue.enqueue(job('acme/a', 'scope', 12, priorities.event));
  const third = await queue.claim();
  await queue.enqueue(job('acme/a', 'scope', 12, priorities.event));
  assert.equal(await queue.fail(third.id, 'network', { retryIn: 0 }), 'superseded');
  assert.deepEqual((await states()).map(s => [s.number, s.state, s.result, s.error_code]), [
    [11, 'failed', null, 'api'], [12, 'done', 'superseded', 'network'], [12, 'pending', null, null]]);
});

test('a job a stopped worker left running is queued again, unless a newer one waits', { skip }, async () => {
  const { queue } = await fresh();
  await queue.enqueue(job('acme/a', 'all', null, priorities.schedule));
  await queue.enqueue(job('acme/b', 'all', null, priorities.schedule));
  await queue.claim();
  await queue.claim();
  await queue.enqueue(job('acme/b', 'all', null, priorities.schedule));
  assert.equal(await queue.resetStale(60_000), 0);
  await pool.query(`UPDATE job SET started_at = now() - interval '2 minutes' WHERE state = 'running'`);
  assert.equal(await queue.resetStale(60_000), 1);
  assert.deepEqual((await states()).map(s => [s.repository, s.state, s.result]), [
    ['acme/a', 'pending', null], ['acme/b', 'done', 'superseded'], ['acme/b', 'pending', null]]);
});

test('finished jobs and old deliveries are pruned; a delivery is acted on once', { skip }, async () => {
  const { queue, deliveries } = await fresh();
  await queue.enqueue(job('acme/a', 'all', null, priorities.schedule));
  await queue.finish((await queue.claim()).id, 'drawn 0');
  assert.equal(await queue.prune(60_000), 0);
  await pool.query(`UPDATE job SET finished_at = now() - interval '2 minutes'`);
  assert.equal(await queue.prune(60_000), 1);
  assert.equal(await deliveries.first('d-1'), true);
  assert.equal(await deliveries.first('d-1'), false);
  await pool.query(`UPDATE delivery SET received_at = now() - interval '2 minutes'`);
  assert.equal(await deliveries.prune(60_000), 1);
});

test('the registry follows each installation\'s repositories and leaves suspended ones out of the rebuild', { skip }, async () => {
  const { registry } = await fresh();
  assert.deepEqual(await registry.syncInstallation({ id: 1, account: 'acme', suspended: false }, ['acme/a', 'acme/b']), ['acme/a', 'acme/b']);
  assert.deepEqual(await registry.syncInstallation({ id: 1, account: 'acme', suspended: false }, ['acme/b', 'acme/c']), ['acme/c']);
  await registry.syncInstallation({ id: 2, account: 'other', suspended: true }, ['other/x']);
  assert.deepEqual((await registry.active()).map(r => r.fullName), ['acme/b', 'acme/c']);
  assert.deepEqual(await registry.repository('other/x'), { fullName: 'other/x', installationId: 2, suspended: true });
  assert.equal(await registry.repository('acme/a'), null);
  await registry.record('acme/b', { configState: 'ready', result: 'drawn #10' });
  const { rows } = await pool.query(`SELECT config_state, last_result FROM repository WHERE full_name = 'acme/b'`);
  assert.deepEqual(rows[0], { config_state: 'ready', last_result: 'drawn #10' });
  assert.equal(await registry.removeInstallationsExcept([1]), 1);
  assert.equal(await registry.repository('other/x'), null);
});

test('webhooks add and remove repositories one by one, and a forgotten delivery can be acted on again', { skip }, async () => {
  const { registry, deliveries } = await fresh();
  await registry.upsertInstallation({ id: 3, account: 'acme', suspended: false });
  assert.deepEqual(await registry.addRepositories(3, ['acme/a', 'acme/b']), ['acme/a', 'acme/b']);
  assert.deepEqual(await registry.addRepositories(3, ['acme/b', 'acme/c']), ['acme/c']);
  await registry.removeRepositories(['acme/a']);
  await registry.upsertInstallation({ id: 3, account: 'acme', suspended: true });
  assert.deepEqual(await registry.repository('acme/b'), { fullName: 'acme/b', installationId: 3, suspended: true });
  assert.deepEqual(await registry.active(), []);
  assert.equal(await registry.repository('acme/a'), null);
  assert.equal(await deliveries.first('d-9'), true);
  await deliveries.forget('d-9');
  assert.equal(await deliveries.first('d-9'), true);
});
