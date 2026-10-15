import { setTimeout as sleep } from 'node:timers/promises';
import { ShapeUpError } from 'gh-vulpes-shapeup/domain';
import { readRepositoryConfig } from './repository-config.mjs';
import { HillService } from './service.mjs';
import { GeneratedStore } from './store.mjs';

// The delay before each retry of a transient failure; after the last, the job fails.
export const retryDelays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

// A failure worth retrying: GitHub unreachable, overloaded or rate-limited, or a race on the generated branch.
export function transient(error) {
  if (!(error instanceof ShapeUpError)) return false;
  if (['network', 'conflict'].includes(error.code)) return true;
  return error.code === 'api' && (error.status >= 500 || [403, 429].includes(error.status));
}

const defaultEngine = (api, config) => new HillService(api, new GeneratedStore(api, config.generatedBranch), config);

// Takes one job at a time and runs it through the hill chart engine on a token for that repository alone.
export class Worker {
  constructor({ queue, registry, auth, log = () => {}, engine = defaultEngine, idleMs = 2_000, now = Date.now }) {
    this.queue = queue;
    this.registry = registry;
    this.auth = auth;
    this.log = log;
    this.engine = engine;
    this.idleMs = idleMs;
    this.now = now;
    this.stopping = false;
  }
  async draw(job) {
    const api = await this.auth.github(job.installationId, job.repository);
    const read = await readRepositoryConfig(api);
    if (read.state !== 'ready') {
      await this.registry.record(job.repository, { configState: read.state, configReason: read.reason, result: 'skipped' });
      return `skipped (${read.state})`;
    }
    const { config } = read;
    if (job.kind === 'scope' && job.labels && !job.labels.includes(config.scopeLabel)) return 'ignored (not a scope)';
    const hill = this.engine(api, config);
    const result = job.kind === 'all' ? `aligned ${await hill.alignAll()}` : await hill.redraw(job.number, job.kind);
    await this.registry.record(job.repository, { configState: 'ready', result });
    return result;
  }
  // Runs the next job, if any, and says whether there was one.
  async runOnce() {
    const job = await this.queue.claim();
    if (!job) return false;
    const started = this.now();
    const entry = { event: 'job', id: job.id, repository: job.repository, kind: job.kind, number: job.number, attempt: job.attempts };
    try {
      const result = await this.draw(job);
      await this.queue.finish(job.id, result);
      this.log({ level: 'info', ...entry, result, ms: this.now() - started });
    } catch (error) {
      const code = error instanceof ShapeUpError ? error.code : 'unexpected';
      const retryIn = transient(error) ? retryDelays[job.attempts - 1] ?? null : null;
      const outcome = await this.queue.fail(job.id, code, { retryIn });
      // A ShapeUpError's message is written for people and holds no secret; anything else is reported by code alone.
      this.log({ level: 'error', ...entry, code, outcome, message: error instanceof ShapeUpError ? error.message : undefined, ms: this.now() - started });
    }
    return true;
  }
  // Works until stopped, finishing the job in hand first.
  async run() {
    while (!this.stopping) {
      let worked = false;
      try {
        worked = await this.runOnce();
      } catch (error) {
        this.log({ level: 'error', event: 'queue', code: error?.code ?? 'unexpected' });
      }
      if (!worked && !this.stopping) await sleep(this.idleMs);
    }
  }
  stop() {
    this.stopping = true;
  }
}
