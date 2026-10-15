import test from 'node:test';
import assert from 'node:assert/strict';
import { GeneratedStore, generatedReadme } from '../src/store.mjs';

function gitFixture() {
  const requests = [];
  let head = null, sequence = 0;
  const commits = new Map(), trees = new Map(), blobs = new Map();
  const api = { async rest(path, options = {}) {
    const { body, method = 'GET' } = options;
    requests.push({ path, method, body });
    if (path.startsWith('/git/ref/')) return head ? { object: { sha: head } } : null;
    if (path.startsWith('/git/commits/') && method === 'GET') return commits.get(path.split('/').at(-1));
    if (path.startsWith('/git/trees/') && method === 'GET') return trees.get(path.split('/').at(-1).split('?')[0]);
    if (path.startsWith('/git/blobs/')) return { content: Buffer.from(blobs.get(path.split('/').at(-1))).toString('base64') };
    if (path === '/git/trees') {
      const old = body.base_tree ? trees.get(body.base_tree).tree : [];
      const map = new Map(old.map(file => [file.path, file]));
      for (const file of body.tree) {
        const sha = `b${++sequence}`;
        blobs.set(sha, file.content);
        map.set(file.path, { path: file.path, sha, mode: file.mode, type: file.type });
      }
      const sha = `t${++sequence}`, tree = { sha, tree: [...map.values()] };
      trees.set(sha, tree); return tree;
    }
    if (path === '/git/commits') {
      const sha = `c${++sequence}`;
      const commit = { sha, tree: { sha: body.tree }, parents: body.parents };
      commits.set(sha, commit); return commit;
    }
    if (path === '/git/refs' && head || path.startsWith('/git/refs/heads/') && commits.get(body.sha).parents[0] !== head) {
      const error = new Error('conflict'); error.status = 422; throw error;
    }
    if (path.startsWith('/git/refs')) { head = body.sha; return {}; }
    throw Error(`Unexpected ${method} ${path}`);
  } };
  return { api, requests, head: () => head };
}
test('Git Data first commit is parentless, later commits append without force', async () => {
  const f = gitFixture();
  const store = new GeneratedStore(f.api, 'generated/shapeup');
  await store.load();
  const first = await store.write({ 'hills/pitch-1.svg': '<svg>1</svg>' }, 'chore(shapeup): first');
  const second = await store.write({ 'hills/pitch-1.svg': '<svg>2</svg>' }, 'chore(shapeup): second');
  assert.notEqual(first, second);
  assert.equal(await store.write({ 'hills/pitch-1.svg': '<svg>2</svg>' }, 'same'), second);
  const commits = f.requests.filter(request => request.path === '/git/commits');
  assert.deepEqual(commits[0].body.parents, []);
  assert.deepEqual(commits[1].body.parents, [first]);
  assert.equal(commits.length, 2);
  assert.ok(f.requests.filter(request => request.method === 'PATCH').every(request => request.body.force === false));
  const reloaded = new GeneratedStore(f.api, 'generated/shapeup');
  await reloaded.load();
  assert.equal(await reloaded.read('hills/pitch-1.svg'), '<svg>2</svg>');
  assert.equal(await reloaded.read('README.md'), generatedReadme);
});
test('a README from an older wording still marks the branch as generated output', async () => {
  const f = gitFixture();
  const store = new GeneratedStore(f.api, 'generated/shapeup');
  await store.load();
  await store.write({ 'README.md': '# Shape Up generated data\n\nOlder wording.\n' }, 'older readme');
  await assert.doesNotReject(new GeneratedStore(f.api, 'generated/shapeup').load());
});
test('concurrent orphan creation and stale ref update fail without overwriting winner', async () => {
  const f = gitFixture();
  const a = new GeneratedStore(f.api, 'generated/shapeup'), b = new GeneratedStore(f.api, 'generated/shapeup');
  await a.load(); await b.load();
  await a.write({ 'hills/pitch-1.svg': 'a' }, 'a');
  const first = f.head();
  await assert.rejects(b.write({ 'hills/pitch-2.svg': 'b' }, 'b'), { code: 'conflict' });
  assert.equal(f.head(), first);
  await b.load();
  await a.write({ 'hills/pitch-1.svg': 'a2' }, 'a2');
  const second = f.head();
  await assert.rejects(b.write({ 'hills/pitch-2.svg': 'b2' }, 'b2'), { code: 'conflict' });
  assert.equal(f.head(), second);
  await b.load();
  await b.write({ 'hills/pitch-2.svg': 'b2' }, 'retry');
  assert.equal(await b.read('hills/pitch-1.svg'), 'a2');
});
test('a branch holding any other file is never treated as generated output', async () => {
  const f = gitFixture();
  const store = new GeneratedStore(f.api, 'generated/shapeup');
  await store.load();
  await store.write({ 'history/pitch-1.json': '{}' }, 'foreign');
  await assert.rejects(new GeneratedStore(f.api, 'generated/shapeup').load(), { code: 'branch' });
});
test('only a generated/ branch can hold generated output', () => {
  for (const branch of ['develop', 'main', 'feature/x']) assert.throws(() => new GeneratedStore({}, branch), { code: 'branch' });
  assert.doesNotThrow(() => new GeneratedStore({}, 'generated/charts'));
});
