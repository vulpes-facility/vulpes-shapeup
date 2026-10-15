import { parseConfig } from 'gh-vulpes-shapeup/config';
import { ShapeUpError } from 'gh-vulpes-shapeup/domain';

export const configPath = '.github/shapeup.json';

// Reads the repository's config from its default branch. Only a ready config is drawn for;
// every other state is recorded with a reason, and the repository is skipped.
export async function readRepositoryConfig(api) {
  const file = await api.rest(`/contents/${configPath}`, { missing: true });
  if (!file) return { state: 'missing', reason: `There is no ${configPath} on the default branch.` };
  if (file.type !== 'file' || file.encoding !== 'base64') return { state: 'invalid', reason: `${configPath} is not a file.` };
  let config;
  try {
    config = parseConfig(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch (error) {
    return { state: 'invalid', reason: error instanceof ShapeUpError ? error.message : `${configPath} cannot be read.` };
  }
  // A GitHub App cannot reach a project that a user owns.
  if (config.projectOwnerType !== 'organization') return { state: 'unsupported', reason: 'The project is owned by a user, which a GitHub App cannot reach.' };
  return { state: 'ready', config };
}
