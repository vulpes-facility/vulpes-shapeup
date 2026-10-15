import { priorities } from './queue.mjs';

// Brings the registry in step with every installation GitHub lists, and queues a rebuild of each repository that is new to it.
// A suspended installation keeps its repositories, since no token can be minted to list them.
export async function syncInstallations({ auth, registry, queue }) {
  const installations = await auth.installations();
  let added = 0;
  for (const installation of installations) {
    const record = { id: installation.id, account: installation.account?.login ?? '', suspended: Boolean(installation.suspended_at) };
    if (record.suspended) {
      await registry.upsertInstallation(record);
      continue;
    }
    const repositories = (await auth.repositories(installation.id)).map(repository => repository.full_name);
    for (const repository of await registry.syncInstallation(record, repositories)) {
      await queue.enqueue({ repository, installationId: record.id, kind: 'all', priority: priorities.install });
      added++;
    }
  }
  const removed = await registry.removeInstallationsExcept(installations.map(installation => installation.id));
  return { installations: installations.length, added, removed };
}

// Queues the scheduled rebuild: one job per repository of every active installation.
export async function queueRebuild({ registry, queue }) {
  let queued = 0;
  for (const { fullName, installationId } of await registry.active()) {
    if (await queue.enqueue({ repository: fullName, installationId, kind: 'all', priority: priorities.schedule })) queued++;
  }
  return queued;
}
