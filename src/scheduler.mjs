import { ShapeUpError } from 'gh-vulpes-shapeup/domain';
import { matches, parseCron } from './cron.mjs';

// Runs each task in the minutes its cron schedule names, checked once a minute.
// A task still running when its next minute comes is not started twice.
export class Scheduler {
  constructor(tasks, { log = () => {} } = {}) {
    this.tasks = tasks.map(task => ({ ...task, schedule: parseCron(task.cron), running: false }));
    this.log = log;
    this.timer = null;
  }
  // Starts every task due at the given minute, and returns their names.
  tick(date) {
    const started = [];
    for (const task of this.tasks) {
      if (task.running || !matches(task.schedule, date)) continue;
      task.running = true;
      started.push(task.name);
      task.promise = Promise.resolve()
        .then(() => task.run())
        .then(result => this.log({ level: 'info', event: 'task', task: task.name, result }))
        .catch(error => this.log({ level: 'error', event: 'task', task: task.name, code: error?.code ?? 'unexpected', message: error instanceof ShapeUpError ? error.message : undefined }))
        .finally(() => { task.running = false; });
    }
    return started;
  }
  start(now = () => new Date()) {
    const next = () => {
      const date = now();
      this.timer = setTimeout(() => { this.tick(now()); next(); }, 60_000 - (date.getTime() % 60_000));
    };
    next();
  }
  // Stops starting tasks, and waits for the ones running.
  async stop() {
    clearTimeout(this.timer);
    await Promise.all(this.tasks.map(task => task.promise));
  }
}
