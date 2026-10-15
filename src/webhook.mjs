import { createHmac, timingSafeEqual } from 'node:crypto';
import { priorities } from './queue.mjs';

// GitHub signs the raw body with the webhook secret. The comparison takes the same time whatever the header holds.
export function validSignature(secret, body, header) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const reply = (status, message) => ({ status, message });
const installationOf = payload => ({
  id: payload.installation.id, account: payload.installation.account?.login ?? '', suspended: Boolean(payload.installation.suspended_at),
});
const names = repositories => (repositories ?? []).map(repository => repository.full_name);

// Turns a verified delivery into jobs. It only does what is cheap: the worker reads the config,
// checks the scope label and leaves alone a chart that already matches the board.
export class WebhookHandler {
  constructor({ secret, deliveries, queue, registry, resolveIssue }) {
    this.secret = secret;
    this.deliveries = deliveries;
    this.queue = queue;
    this.registry = registry;
    this.resolveIssue = resolveIssue;
  }
  async handle({ event, delivery, signature, body }) {
    if (!validSignature(this.secret, body, signature)) return reply(401, 'The signature does not match.');
    if (!event || !delivery) return reply(400, 'The event or delivery header is missing.');
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch { return reply(400, 'The body is not JSON.'); }
    if (!(await this.deliveries.first(delivery))) return reply(200, 'This delivery was already handled.');
    try {
      return await this.route(event, payload);
    } catch (error) {
      await this.deliveries.forget(delivery);
      throw error;
    }
  }
  route(event, payload) {
    switch (event) {
      case 'ping': return reply(200, 'pong');
      case 'installation': return this.installation(payload);
      case 'installation_repositories': return this.installationRepositories(payload);
      case 'issues':
        if (!['opened', 'closed', 'reopened'].includes(payload.action)) return reply(200, `Ignored: issues ${payload.action}.`);
        return this.scope(payload.repository.full_name, payload.issue);
      case 'issue_comment':
        // Comments the App or another bot posts never start a job, as the hill chart Action ignored them.
        if (payload.action !== 'created' || payload.issue.pull_request || payload.comment.user?.type === 'Bot') return reply(200, 'Ignored: not a person\'s new comment on an issue.');
        return this.scope(payload.repository.full_name, payload.issue);
      case 'projects_v2_item': return this.projectItem(payload);
      default: return reply(200, `Ignored: ${event}.`);
    }
  }
  async scope(repository, issue) {
    const known = await this.registry.repository(repository);
    if (!known || known.suspended) return reply(200, `Ignored: the App does not draw for ${repository}.`);
    const labels = issue.labels?.map(label => label.name) ?? null;
    await this.queue.enqueue({ repository, installationId: known.installationId, kind: 'scope', number: issue.number, labels, priority: priorities.event });
    return reply(202, `Queued ${repository}#${issue.number}.`);
  }
  async projectItem(payload) {
    const item = payload.projects_v2_item;
    if (payload.action !== 'edited' || item?.content_type !== 'Issue') return reply(200, 'Ignored: not an edit of an issue on the board.');
    const issue = await this.resolveIssue(payload.installation.id, item.content_node_id);
    if (!issue) return reply(200, 'Ignored: the item\'s issue cannot be read.');
    return this.scope(issue.repository, { number: issue.number, labels: issue.labels.map(name => ({ name })) });
  }
  async installation(payload) {
    const installation = installationOf(payload);
    if (payload.action === 'deleted') {
      await this.registry.removeInstallation(installation.id);
      return reply(200, `Removed installation ${installation.id}.`);
    }
    if (!['created', 'suspend', 'unsuspend'].includes(payload.action)) return reply(200, `Ignored: installation ${payload.action}.`);
    await this.registry.upsertInstallation(installation);
    if (payload.action !== 'created') return reply(200, `Installation ${installation.id} is ${installation.suspended ? 'suspended' : 'active'}.`);
    return this.added(installation, names(payload.repositories));
  }
  async installationRepositories(payload) {
    const installation = installationOf(payload);
    await this.registry.upsertInstallation(installation);
    await this.registry.removeRepositories(names(payload.repositories_removed));
    return this.added(installation, names(payload.repositories_added));
  }
  // A repository the App was just installed on gets one rebuild, ahead of the schedule.
  async added(installation, repositories) {
    const added = await this.registry.addRepositories(installation.id, repositories);
    if (!installation.suspended) {
      for (const repository of added) {
        await this.queue.enqueue({ repository, installationId: installation.id, kind: 'all', priority: priorities.install });
      }
    }
    return reply(202, `Added ${added.length} repositories to installation ${installation.id}.`);
  }
}
