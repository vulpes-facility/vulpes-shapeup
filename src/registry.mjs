// The installations and repositories the App can reach, each repository's config state and its last result.
export class Registry {
  constructor(pool) {
    this.pool = pool;
  }
  // Replaces what is known of one installation with what GitHub lists now, and returns the repositories that are new.
  async syncInstallation({ id, account, suspended }, repositories) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO installation (id, account, suspended, synced_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE SET account = excluded.account, suspended = excluded.suspended, synced_at = now()`,
        [id, account, suspended]);
      await client.query('DELETE FROM repository WHERE installation_id = $1 AND NOT (full_name = ANY($2))', [id, repositories]);
      const { rows } = await client.query(
        `INSERT INTO repository (full_name, installation_id) SELECT unnest($2::text[]), $1
         ON CONFLICT (full_name) DO UPDATE SET installation_id = excluded.installation_id
         RETURNING full_name, (xmax = 0) AS added`, [id, repositories]);
      await client.query('COMMIT');
      return rows.filter(row => row.added).map(row => row.full_name);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  // An installation GitHub no longer lists is gone, with its repositories.
  async removeInstallationsExcept(ids) {
    const { rowCount } = await this.pool.query('DELETE FROM installation WHERE NOT (id = ANY($1::bigint[]))', [ids]);
    return rowCount;
  }
  async removeInstallation(id) {
    await this.pool.query('DELETE FROM installation WHERE id = $1', [id]);
  }
  async repository(fullName) {
    const { rows } = await this.pool.query(
      `SELECT r.full_name AS "fullName", r.installation_id AS "installationId", i.suspended
       FROM repository r JOIN installation i ON i.id = r.installation_id WHERE r.full_name = $1`, [fullName]);
    return rows[0] ?? null;
  }
  // The repositories a scheduled rebuild visits: every one of an installation that is not suspended.
  async active() {
    const { rows } = await this.pool.query(
      `SELECT r.full_name AS "fullName", r.installation_id AS "installationId"
       FROM repository r JOIN installation i ON i.id = r.installation_id
       WHERE NOT i.suspended ORDER BY r.full_name`);
    return rows;
  }
  async record(fullName, { configState, configReason = null, result }) {
    await this.pool.query(
      `UPDATE repository SET config_state = $2, config_reason = $3, last_result = $4, last_job_at = now() WHERE full_name = $1`,
      [fullName, configState, configReason, result]);
  }
}
