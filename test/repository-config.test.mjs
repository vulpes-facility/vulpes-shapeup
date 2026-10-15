import test from 'node:test';
import assert from 'node:assert/strict';
import { readRepositoryConfig } from '../src/repository-config.mjs';

const base64 = text => Buffer.from(text).toString('base64');
const api = file => ({ calls: [], async rest(path, options) { this.calls.push([path, options]); return file; } });
const organization = { projectOwner: 'acme', projectOwnerType: 'organization', projectNumber: 1 };

test('a config on the default branch is ready when its project belongs to an organization', async () => {
  const a = api({ type: 'file', encoding: 'base64', content: base64(JSON.stringify(organization)) });
  const result = await readRepositoryConfig(a);
  assert.equal(result.state, 'ready');
  assert.equal(result.config.projectOwner, 'acme');
  assert.equal(result.config.hillField, 'Hill Position');
  assert.deepEqual(a.calls, [['/contents/.github/shapeup.json', { missing: true }]]);
});

test('a missing, broken or user-owned config is skipped with its reason', async () => {
  for (const [file, state, reason] of [
    [null, 'missing', 'There is no .github/shapeup.json on the default branch.'],
    [[{ type: 'file' }], 'invalid', '.github/shapeup.json is not a file.'],
    [{ type: 'file', encoding: 'base64', content: base64('{ nope') }, 'invalid', 'The config file is not valid JSON.'],
    [{ type: 'file', encoding: 'base64', content: base64('{"projectOwnerType":"organization","projectNumber":1}') }, 'invalid', 'projectOwner is required.'],
    [{ type: 'file', encoding: 'base64', content: base64(JSON.stringify({ ...organization, projectOwnerType: 'user' })) }, 'unsupported',
      'The project is owned by a user, which a GitHub App cannot reach.'],
  ]) {
    assert.deepEqual(await readRepositoryConfig(api(file)), { state, reason }, reason);
  }
});
