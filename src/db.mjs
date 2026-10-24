import pg from 'pg';

// Each migration runs once, in order, inside the transaction that records it.
// The database holds only state the server can rebuild: installations, repositories, jobs and deliveries.
export const migrations = [
  `CREATE TABLE installation (
     id bigint PRIMARY KEY,
     account text NOT NULL,
     suspended boolean NOT NULL DEFAULT false,
     synced_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE repository (
     full_name text PRIMARY KEY,
     installation_id bigint NOT NULL REFERENCES installation (id) ON DELETE CASCADE,
     config_state text NOT NULL DEFAULT 'unknown',
     config_reason text,
     last_result text,
     last_job_at timestamptz
   );
   CREATE TABLE job (
     id bigserial PRIMARY KEY,
     repository text NOT NULL,
     installation_id bigint NOT NULL,
     kind text NOT NULL CHECK (kind IN ('scope', 'pitch', 'all')),
     number integer,
     labels text[],
     priority smallint NOT NULL,
     state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'done', 'failed')),
     attempts smallint NOT NULL DEFAULT 0,
     available_at timestamptz NOT NULL DEFAULT now(),
     created_at timestamptz NOT NULL DEFAULT now(),
     started_at timestamptz,
     finished_at timestamptz,
     result text,
     error_code text
   );
   CREATE UNIQUE INDEX job_pending_once ON job (repository, kind, (coalesce(number, 0))) WHERE state = 'pending';
   CREATE UNIQUE INDEX job_running_once ON job (repository) WHERE state = 'running';
   CREATE INDEX job_claim ON job (priority, available_at, id) WHERE state = 'pending';
   CREATE TABLE delivery (
     id text PRIMARY KEY,
     received_at timestamptz NOT NULL DEFAULT now()
   );`,
];

// Every bigint here is an id well below 2^53, so it is read as a number rather than a string.
pg.types.setTypeParser(pg.types.builtins.INT8, value => Number(value));

// pg lets the connection string override a separate password, so a password from its own file is put into the string,
// in memory only.
export function createPool(databaseUrl, password = null) {
  let connectionString = databaseUrl;
  if (password !== null) {
    const url = new URL(databaseUrl);
    url.password = encodeURIComponent(password);
    connectionString = url.toString();
  }
  // A connection that is not up in ten seconds fails, rather than waiting on the operating system's timeout.
  return new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 10_000 });
}

// The longest the server waits at start for PostgreSQL, which may still be starting beside it.
export const startWaitMs = 120_000;

// Connects until PostgreSQL takes a connection, waiting longer after each failure.
// The wait ends at the first failure whose next sleep would pass startWaitMs, so with the last connection's timeout it can run ten seconds over.
// An error that PostgreSQL itself returns, such as a wrong password or a missing database, ends the wait at once,
// except the 57P states, which PostgreSQL returns while it starts up or shuts down.
export async function waitForDatabase(pool, { log = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try {
      (await pool.connect()).release();
      return attempt;
    } catch (error) {
      const delay = Math.min(1_000 * 2 ** (attempt - 1), 15_000);
      const refused = error instanceof pg.DatabaseError && !error.code?.startsWith('57P');
      if (refused || now() - started + delay > startWaitMs) throw error;
      log({ level: 'warn', event: 'database', code: error?.code ?? 'unexpected', attempt, retryInMs: delay });
      await sleep(delay);
    }
  }
}

// A transaction-scoped advisory lock lets one server migrate while another waits for it.
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext(\'vulpes-shapeup migrations\'))');
    await client.query('CREATE TABLE IF NOT EXISTS migration (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT coalesce(max(version), 0) AS version FROM migration');
    const applied = rows[0].version;
    for (let version = applied + 1; version <= migrations.length; version++) {
      await client.query(migrations[version - 1]);
      await client.query('INSERT INTO migration (version) VALUES ($1)', [version]);
    }
    await client.query('COMMIT');
    return migrations.length - applied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
