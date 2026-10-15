import test from 'node:test';
import assert from 'node:assert/strict';
import { priorities } from '../src/queue.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { queueRebuild, syncInstallations } from '../src/sync.mjs';

test('a sync follows every installation, rebuilds new repositories and drops what GitHub no longer lists', async () => {
  const calls = [];
  const auth = {
    async installations() { return [{ id: 1, account: { login: 'acme' }, suspended_at: null }, { id: 2, account: { login: 'paused' }, suspended_at: '2026-10-01T00:00:00Z' }]; },
    async repositories(id) { calls.push(['repositories', id]); return [{ full_name: 'acme/a' }, { full_name: 'acme/b' }]; },
  };
  const registry = {
    async syncInstallation(record, names) { calls.push(['sync', record, names]); return ['acme/b']; },
    async upsertInstallation(record) { calls.push(['upsert', record]); },
    async removeInstallationsExcept(ids) { calls.push(['keep', ids]); return 3; },
  };
  const queue = { async enqueue(job) { calls.push(['enqueue', job]); return true; } };
  assert.deepEqual(await syncInstallations({ auth, registry, queue }), { installations: 2, added: 1, removed: 3 });
  assert.deepEqual(calls, [
    ['repositories', 1], ['sync', { id: 1, account: 'acme', suspended: false }, ['acme/a', 'acme/b']],
    ['enqueue', { repository: 'acme/b', installationId: 1, kind: 'all', priority: priorities.install }],
    ['upsert', { id: 2, account: 'paused', suspended: true }], ['keep', [1, 2]],
  ]);
});

test('the scheduled rebuild queues one job per active repository at schedule priority', async () => {
  const jobs = [];
  const registry = { async active() { return [{ fullName: 'acme/a', installationId: 1 }, { fullName: 'acme/b', installationId: 1 }]; } };
  const queue = { async enqueue(job) { jobs.push(job); return job.repository === 'acme/a'; } };
  assert.equal(await queueRebuild({ registry, queue }), 1);
  assert.deepEqual(jobs.map(job => [job.repository, job.kind, job.priority]), [['acme/a', 'all', priorities.schedule], ['acme/b', 'all', priorities.schedule]]);
});

test('the scheduler starts each task in its minutes, never twice at once, and logs failures by code', async () => {
  const log = [];
  let release;
  const runs = [];
  const scheduler = new Scheduler([
    { name: 'hourly', cron: '0 * * * *', run: () => { runs.push('hourly'); return new Promise(resolve => { release = resolve; }); } },
    { name: 'broken', cron: '*/5 * * * *', run: async () => { throw Object.assign(new Error('postgres://u:pw@db'), { code: 'ECONNREFUSED' }); } },
  ], { log: entry => log.push(entry) });
  assert.deepEqual(scheduler.tick(new Date('2026-10-15T10:00:00Z')), ['hourly', 'broken']);
  assert.deepEqual(scheduler.tick(new Date('2026-10-15T10:01:00Z')), []);
  await new Promise(resolve => setImmediate(resolve));
  release({ queued: 2 });
  await scheduler.stop();
  assert.deepEqual(scheduler.tick(new Date('2026-10-15T11:00:00Z')), ['hourly', 'broken']);
  await new Promise(resolve => setImmediate(resolve));
  release({ queued: 0 });
  await scheduler.stop();
  assert.deepEqual(runs, ['hourly', 'hourly']);
  const failure = { level: 'error', event: 'task', task: 'broken', code: 'ECONNREFUSED', message: undefined };
  assert.deepEqual(log.filter(e => e.task === 'broken'), [failure, failure]);
  assert.deepEqual(log.find(e => e.task === 'hourly'), { level: 'info', event: 'task', task: 'hourly', result: { queued: 2 } });
});
