import { once } from 'node:events';
import { ShapeUpError } from 'gh-vulpes-shapeup/domain';
import { AppAuth } from './app-auth.mjs';
import { createPool, migrate, waitForDatabase } from './db.mjs';
import { httpServer } from './http.mjs';
import { resolveIssue } from './project-items.mjs';
import { Deliveries, Queue } from './queue.mjs';
import { Registry } from './registry.mjs';
import { Scheduler } from './scheduler.mjs';
import { loadSettings } from './settings.mjs';
import { queueRebuild, syncInstallations } from './sync.mjs';
import { WebhookHandler } from './webhook.mjs';
import { Worker } from './worker.mjs';

const minutes = n => n * 60_000;
const days = n => n * 24 * 60 * minutes(1);

// One JSON line per entry on stdout. Entries carry codes, names and numbers, never a token, body or secret.
export const jsonLog = entry => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

// Starts every component in one process, and returns a stop that finishes the job in hand.
export async function start(env = process.env, { log = jsonLog, fetchImpl = fetch } = {}) {
  const settings = await loadSettings(env);
  const pool = createPool(settings.databaseUrl, settings.databasePassword);
  try {
    await waitForDatabase(pool, { log });
    await migrate(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const queue = new Queue(pool);
  const registry = new Registry(pool);
  const deliveries = new Deliveries(pool);
  const auth = new AppAuth({ clientId: settings.clientId, privateKey: settings.privateKey, apiUrl: settings.apiUrl, fetchImpl });
  const webhook = new WebhookHandler({ secret: settings.webhookSecret, deliveries, queue, registry,
    resolveIssue: (installationId, nodeId) => resolveIssue(auth, installationId, nodeId) });
  const server = httpServer({ webhook, log });
  server.listen(settings.port);
  await once(server, 'listening');
  log({ level: 'info', event: 'listening', port: server.address().port });

  const sync = async () => {
    const result = await syncInstallations({ auth, registry, queue });
    return { ...result, prunedJobs: await queue.prune(days(30)), prunedDeliveries: await deliveries.prune(days(7)) };
  };
  const rebuild = async () => ({ queued: await queueRebuild({ registry, queue }) });
  // A job runs for a few minutes at most; one running longer belonged to a worker that stopped.
  const maintain = async () => ({ requeued: await queue.resetStale(minutes(15)) });
  const scheduler = new Scheduler([
    { name: 'sync', cron: settings.syncSchedule, run: sync },
    { name: 'rebuild', cron: settings.rebuildSchedule, run: rebuild },
    { name: 'maintain', cron: '*/5 * * * *', run: maintain },
  ], { log });

  // Whatever happened while the server was down is healed at start: the installations are synced and every repository is aligned.
  for (const [name, run] of [['sync', sync], ['rebuild', rebuild]]) {
    try {
      log({ level: 'info', event: 'task', task: name, result: await run() });
    } catch (error) {
      log({ level: 'error', event: 'task', task: name, code: error?.code ?? 'unexpected', message: error instanceof ShapeUpError ? error.message : undefined });
    }
  }
  scheduler.start();
  const worker = new Worker({ queue, registry, auth, log });
  const working = worker.run();

  let stopped = null;
  const stop = () => {
    stopped ??= (async () => {
      log({ level: 'info', event: 'stopping' });
      server.close();
      worker.stop();
      await Promise.all([scheduler.stop(), working]);
      await pool.end();
      log({ level: 'info', event: 'stopped' });
    })();
    return stopped;
  };
  return { stop, server, pool, queue, registry };
}
