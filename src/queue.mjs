// Highest first: someone is likely waiting on an event; a new installation next; the schedule last.
export const priorities = { event: 0, install: 1, schedule: 2 };

const uniqueViolation = '23505';

// Jobs live in PostgreSQL. A repository has at most one pending job per kind and number,
// and at most one running job, so its charts are drawn one at a time.
export class Queue {
  constructor(pool) {
    this.pool = pool;
  }
  // Queues a job, or keeps the one already pending with the higher of the two priorities. Returns whether a job was added.
  async enqueue({ repository, installationId, kind, number = null, labels = null, priority }) {
    const { rows } = await this.pool.query(
      `INSERT INTO job (repository, installation_id, kind, number, labels, priority)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (repository, kind, (coalesce(number, 0))) WHERE state = 'pending'
       DO UPDATE SET priority = least(job.priority, excluded.priority),
                     labels = coalesce(excluded.labels, job.labels),
                     installation_id = excluded.installation_id
       RETURNING (xmax = 0) AS added`,
      [repository, installationId, kind, number, labels, priority]);
    return rows[0].added;
  }
  // Takes the next job whose repository has none running. Another worker taking one for the same repository first
  // makes this claim fail on job_running_once, and the claim is simply tried again.
  async claim() {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { rows } = await this.pool.query(
          `UPDATE job SET state = 'running', started_at = now(), attempts = attempts + 1
           WHERE id = (
             SELECT j.id FROM job j
             WHERE j.state = 'pending' AND j.available_at <= now()
               AND NOT EXISTS (SELECT 1 FROM job r WHERE r.state = 'running' AND r.repository = j.repository)
             ORDER BY j.priority, j.available_at, j.id
             FOR UPDATE SKIP LOCKED
             LIMIT 1)
           RETURNING id, repository, installation_id AS "installationId", kind, number, labels, attempts`);
        return rows[0] ?? null;
      } catch (error) {
        if (error.code !== uniqueViolation) throw error;
      }
    }
    return null;
  }
  async finish(id, result) {
    await this.pool.query(`UPDATE job SET state = 'done', finished_at = now(), result = $2 WHERE id = $1`, [id, result]);
  }
  // A failure is retried after the delay while attempts remain; a job queued meanwhile with the same key replaces it.
  async fail(id, code, { retryIn = null } = {}) {
    if (retryIn !== null) {
      try {
        const { rowCount } = await this.pool.query(
          `UPDATE job SET state = 'pending', started_at = NULL, available_at = now() + make_interval(secs => $2), error_code = $3
           WHERE id = $1`, [id, retryIn / 1000, code]);
        if (rowCount) return 'retry';
      } catch (error) {
        if (error.code !== uniqueViolation) throw error;
        await this.pool.query(`UPDATE job SET state = 'done', finished_at = now(), result = 'superseded', error_code = $2 WHERE id = $1`, [id, code]);
        return 'superseded';
      }
    }
    await this.pool.query(`UPDATE job SET state = 'failed', finished_at = now(), error_code = $2 WHERE id = $1`, [id, code]);
    return 'failed';
  }
  // A job left running longer than the limit belonged to a worker that stopped; it is queued again.
  async resetStale(olderThanMs) {
    const { rowCount } = await this.pool.query(
      `UPDATE job SET state = 'pending', started_at = NULL
       WHERE state = 'running' AND started_at < now() - make_interval(secs => $1)
         AND NOT EXISTS (SELECT 1 FROM job p WHERE p.state = 'pending' AND p.repository = job.repository
                           AND p.kind = job.kind AND coalesce(p.number, 0) = coalesce(job.number, 0))`,
      [olderThanMs / 1000]);
    await this.pool.query(
      `UPDATE job SET state = 'done', finished_at = now(), result = 'superseded'
       WHERE state = 'running' AND started_at < now() - make_interval(secs => $1)`, [olderThanMs / 1000]);
    return rowCount;
  }
  async prune(olderThanMs) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM job WHERE state IN ('done', 'failed') AND finished_at < now() - make_interval(secs => $1)`, [olderThanMs / 1000]);
    return rowCount;
  }
  async counts() {
    const { rows } = await this.pool.query('SELECT state, count(*)::int AS count FROM job GROUP BY state');
    return Object.fromEntries(rows.map(row => [row.state, row.count]));
  }
}

// GitHub can deliver the same webhook twice; a delivery id is acted on once.
export class Deliveries {
  constructor(pool) {
    this.pool = pool;
  }
  async first(id) {
    const { rowCount } = await this.pool.query('INSERT INTO delivery (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    return rowCount === 1;
  }
  // A delivery that failed half-way is forgotten, so that GitHub's redelivery is acted on.
  async forget(id) {
    await this.pool.query('DELETE FROM delivery WHERE id = $1', [id]);
  }
  async prune(olderThanMs) {
    const { rowCount } = await this.pool.query('DELETE FROM delivery WHERE received_at < now() - make_interval(secs => $1)', [olderThanMs / 1000]);
    return rowCount;
  }
}
