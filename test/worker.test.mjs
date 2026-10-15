import test from 'node:test';
import assert from 'node:assert/strict';
import { ShapeUpError } from 'gh-vulpes-shapeup/domain';
import { Worker, retryDelays, transient } from '../src/worker.mjs';

const base64 = value => Buffer.from(JSON.stringify(value)).toString('base64');
const organizationConfig = { projectOwner: 'acme', projectOwnerType: 'organization', projectNumber: 1 };
const apiError = status => Object.assign(new ShapeUpError('api', `GitHub API request failed (HTTP ${status}).`), { status });

// A worker over in-memory stand-ins: one job, a repository whose config the fake API returns, and an engine that records calls.
function setup({ job, config = organizationConfig, engine = {} } = {}) {
  const calls = [];
  const jobs = job ? [{ id: 1, repository: 'acme/game', installationId: 7, attempts: 1, labels: null, number: null, ...job }] : [];
  const queue = {
    async claim() { return jobs.shift() ?? null; },
    async finish(id, result) { calls.push(['finish', id, result]); },
    async fail(id, code, options) { calls.push(['fail', id, code, options]); return options.retryIn === null ? 'failed' : 'retry'; },
  };
  const registry = { async record(name, entry) { calls.push(['record', name, entry]); } };
  const api = { async rest(path) { calls.push(['rest', path]); return config ? { type: 'file', encoding: 'base64', content: base64(config) } : null; } };
  const auth = { async github(installationId, repository) { calls.push(['github', installationId, repository]); return api; } };
  const hill = {
    async redraw(number, type) { calls.push(['redraw', number, type]); return engine.redraw?.(number, type) ?? `drawn #10`; },
    async alignAll() { calls.push(['alignAll']); return engine.alignAll?.() ?? 2; },
  };
  const log = [];
  const worker = new Worker({ queue, registry, auth, log: entry => log.push(entry), engine: (a, c) => { calls.push(['engine', c.scopeLabel]); return hill; }, now: () => 0 });
  return { worker, calls, log };
}

test('a scope job redraws its pitch on a token for its repository, and records the result', async () => {
  const s = setup({ job: { kind: 'scope', number: 11, labels: ['scope'] } });
  assert.equal(await s.worker.runOnce(), true);
  assert.deepEqual(s.calls, [
    ['github', 7, 'acme/game'], ['rest', '/contents/.github/shapeup.json'], ['engine', 'scope'], ['redraw', 11, 'scope'],
    ['record', 'acme/game', { configState: 'ready', result: 'drawn #10' }], ['finish', 1, 'drawn #10'],
  ]);
  assert.deepEqual(s.log, [{ level: 'info', event: 'job', id: 1, repository: 'acme/game', kind: 'scope', number: 11, attempt: 1, result: 'drawn #10', ms: 0 }]);
  assert.equal(await s.worker.runOnce(), false);
});

test('an all job aligns every pitch; an issue without the config\'s scope label is left alone', async () => {
  const all = setup({ job: { kind: 'all' } });
  await all.worker.runOnce();
  assert.deepEqual(all.calls.at(-1), ['finish', 1, 'aligned 2']);
  const other = setup({ job: { kind: 'scope', number: 30, labels: ['bug'] }, config: { ...organizationConfig, scopeLabel: 'Scope' } });
  await other.worker.runOnce();
  assert.ok(!other.calls.some(c => c[0] === 'redraw'));
  assert.deepEqual(other.calls.at(-1), ['finish', 1, 'ignored (not a scope)']);
});

test('a repository without a ready config is skipped with its reason', async () => {
  for (const [config, state] of [[null, 'missing'], [{ ...organizationConfig, projectOwnerType: 'user' }, 'unsupported']]) {
    const s = setup({ job: { kind: 'all' }, config });
    await s.worker.runOnce();
    assert.equal(s.calls.find(c => c[0] === 'record')[2].configState, state);
    assert.deepEqual(s.calls.at(-1), ['finish', 1, `skipped (${state})`]);
    assert.ok(!s.calls.some(c => c[0] === 'engine'));
  }
});

test('a transient failure is retried after a growing delay; any other failure fails at once', async () => {
  assert.ok(transient(new ShapeUpError('network', 'x')));
  assert.ok(transient(new ShapeUpError('conflict', 'x')));
  for (const status of [500, 502, 403, 429]) assert.ok(transient(apiError(status)), String(status));
  for (const error of [apiError(404), apiError(401), new ShapeUpError('type', 'x'), new ShapeUpError('rebuild', 'x'), new Error('boom')]) assert.ok(!transient(error));

  const retried = setup({ job: { kind: 'scope', number: 11, attempts: 2 }, engine: { redraw() { throw apiError(502); } } });
  await retried.worker.runOnce();
  assert.deepEqual(retried.calls.at(-1), ['fail', 1, 'api', { retryIn: retryDelays[1] }]);
  assert.equal(retried.log[0].outcome, 'retry');

  const exhausted = setup({ job: { kind: 'scope', number: 11, attempts: retryDelays.length + 1 }, engine: { redraw() { throw new ShapeUpError('network', 'Could not reach the GitHub API.'); } } });
  await exhausted.worker.runOnce();
  assert.deepEqual(exhausted.calls.at(-1), ['fail', 1, 'network', { retryIn: null }]);

  const broken = setup({ job: { kind: 'all' }, engine: { alignAll() { throw new Error('token ghs_secret in a stack'); } } });
  await broken.worker.runOnce();
  assert.deepEqual(broken.calls.at(-1), ['fail', 1, 'unexpected', { retryIn: null }]);
  assert.ok(!JSON.stringify(broken.log).includes('ghs_secret'));
});

test('a stopped worker finishes the job in hand and takes no other', async () => {
  const s = setup({ job: { kind: 'all' } });
  s.worker.idleMs = 1;
  let release;
  s.worker.engine = () => ({ alignAll: () => new Promise(resolve => { release = () => resolve(1); }) });
  const running = s.worker.run();
  await new Promise(resolve => setTimeout(resolve, 10));
  s.worker.stop();
  release();
  await running;
  assert.deepEqual(s.calls.at(-1), ['finish', 1, 'aligned 1']);
});
