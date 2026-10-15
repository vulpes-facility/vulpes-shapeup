import { GitHub } from 'gh-vulpes-shapeup/github';

// Reading an item's issue needs the board and the issues of every repository the installation reaches.
export const itemPermissions = { organization_projects: 'read', issues: 'read' };

// A Projects item event names its content by node id only, and no repository.
// This finds the issue behind it, or null when the content is not an issue the App can read.
export async function resolveIssue(auth, installationId, contentNodeId) {
  const token = await auth.token(installationId, null, itemPermissions);
  const api = new GitHub({ projectToken: token, apiUrl: auth.apiUrl, fetchImpl: auth.fetch });
  const data = await api.graphql(`query($id: ID!) {
    node(id: $id) { ... on Issue { number repository { nameWithOwner } labels(first: 100) { nodes { name } } } }
  }`, { id: contentNodeId }, { notFound: true });
  const issue = data?.node;
  if (!issue?.number) return null;
  return { repository: issue.repository.nameWithOwner, number: issue.number, labels: issue.labels.nodes.map(label => label.name) };
}
