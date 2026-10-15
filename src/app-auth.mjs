import { createSign } from 'node:crypto';
import { GitHub } from 'gh-vulpes-shapeup/github';

const base64url = value => Buffer.from(value).toString('base64url');

// What a job's token may do: commit the chart, update the pitch body and read the board. Nothing else.
export const jobPermissions = { contents: 'write', issues: 'write', organization_projects: 'read' };

// A token is reused until five minutes before it expires, so a job never starts with one about to lapse.
const margin = 5 * 60_000;

// The JWT that proves the App. GitHub takes one for at most ten minutes; the issue time is set back a minute for clock drift.
export function appJwt(clientId, privateKey, now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: clientId }))}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;
}

export class AppAuth {
  constructor({ clientId, privateKey, apiUrl = 'https://api.github.com', fetchImpl = fetch, now = Date.now }) {
    this.clientId = clientId;
    this.privateKey = privateKey;
    this.apiUrl = apiUrl;
    this.fetch = fetchImpl;
    this.now = now;
    this.tokens = new Map();
  }
  // Calls as the App go through the same transport, so no GitHub response reaches a message.
  request(path, options) {
    const app = new GitHub({ repositoryToken: appJwt(this.clientId, this.privateKey, this.now()), apiUrl: this.apiUrl, fetchImpl: this.fetch });
    return app.request(path, options);
  }
  async installations() {
    const all = [];
    for (let page = 1; ; page++) {
      const batch = await this.request(`/app/installations?per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }
  // A token narrowed to one repository with the job's permissions; without a repository, one for the whole installation
  // with the permissions given, the installation's metadata by default.
  async token(installationId, repository = null, permissions = { metadata: 'read' }) {
    const key = `${installationId}/${repository ?? JSON.stringify(permissions)}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expires - this.now() > margin) return cached.token;
    const body = repository ? { repositories: [repository.split('/')[1]], permissions: jobPermissions } : { permissions };
    const result = await this.request(`/app/installations/${installationId}/access_tokens`, { method: 'POST', body });
    this.tokens.set(key, { token: result.token, expires: Date.parse(result.expires_at) });
    return result.token;
  }
  async repositories(installationId) {
    const api = new GitHub({ repositoryToken: await this.token(installationId), apiUrl: this.apiUrl, fetchImpl: this.fetch });
    const all = [];
    for (let page = 1; ; page++) {
      const { repositories } = await api.request(`/installation/repositories?per_page=100&page=${page}`);
      all.push(...repositories);
      if (repositories.length < 100) return all;
    }
  }
  // The transport a job runs on: one installation token reads the board and writes the repository.
  async github(installationId, repository) {
    const token = await this.token(installationId, repository);
    return new GitHub({ repository, repositoryToken: token, projectToken: token, apiUrl: this.apiUrl, fetchImpl: this.fetch });
  }
}
