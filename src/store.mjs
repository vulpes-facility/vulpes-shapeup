import { ShapeUpError } from 'gh-vulpes-shapeup/domain';

export const readmeHeading = '# Shape Up generated data';
export const generatedReadme = `${readmeHeading}

This orphan branch is written by the vulpes-shapeup App.
Do not edit it by hand, merge it into another branch, or open pull requests against it.
Hill positions live in the GitHub Project; this branch only keeps the SVG charts drawn from them.
`;

export class GeneratedStore {
  constructor(api, branch) {
    if (!/^generated\/[A-Za-z0-9._/-]+$/.test(branch)) throw new ShapeUpError('branch', 'The generated branch must start with "generated/".');
    this.api = api;
    this.branch = branch;
    this.files = new Map();
    this.cache = new Map();
  }
  async load() {
    const ref = await this.api.rest(`/git/ref/heads/${this.branch}`, { missing: true });
    this.sha = ref?.object.sha ?? null;
    this.treeSha = null;
    this.files.clear();
    this.cache.clear();
    if (!this.sha) return;
    const commit = await this.api.rest(`/git/commits/${this.sha}`);
    this.treeSha = commit.tree.sha;
    const tree = await this.api.rest(`/git/trees/${this.treeSha}?recursive=1`);
    if (tree.truncated) throw new ShapeUpError('tree', 'Cannot list every file on the generated branch.');
    for (const file of tree.tree) {
      if (file.type === 'tree' && file.path === 'hills') continue;
      if (file.type !== 'blob' || file.mode !== '100644' ||
          !/^(README\.md|hills\/pitch-[1-9][0-9]*\.svg)$/.test(file.path)) {
        throw new ShapeUpError('branch', 'The generated branch holds an unexpected file; an ordinary branch is never used as generated output.');
      }
      this.files.set(file.path, file.sha);
    }
    // Only the heading marks ownership, so the README's wording can change between versions.
    if (!(await this.read('README.md'))?.startsWith(`${readmeHeading}\n`)) {
      throw new ShapeUpError('branch', 'The generated branch has no ownership README; it is left untouched.');
    }
  }
  async read(path) {
    if (this.cache.has(path)) return this.cache.get(path);
    const sha = this.files.get(path);
    if (!sha) return null;
    const blob = await this.api.rest(`/git/blobs/${sha}`);
    const content = Buffer.from(blob.content, 'base64').toString('utf8');
    this.cache.set(path, content);
    return content;
  }
  async write(files, message) {
    const updates = new Map(Object.entries(files));
    if (!this.sha) updates.set('README.md', generatedReadme);
    for (const [path, content] of updates) {
      if (await this.read(path) === content) updates.delete(path);
    }
    if (!updates.size) return this.sha;
    const tree = await this.api.rest('/git/trees', { method: 'POST', body: {
      ...(this.treeSha ? { base_tree: this.treeSha } : {}),
      tree: [...updates].map(([path, content]) => ({ path, content, mode: '100644', type: 'blob' })),
    } });
    const commit = await this.api.rest('/git/commits', { method: 'POST', body: {
      message, tree: tree.sha, parents: this.sha ? [this.sha] : [],
    } });
    try {
      if (this.sha) await this.api.rest(`/git/refs/heads/${this.branch}`, {
        method: 'PATCH', body: { sha: commit.sha, force: false },
      });
      else await this.api.rest('/git/refs', { method: 'POST', body: {
        ref: `refs/heads/${this.branch}`, sha: commit.sha,
      } });
    } catch (error) {
      if ([409, 422].includes(error.status)) throw new ShapeUpError('conflict', 'Updating the generated branch conflicted. Nothing was forced; run it again.');
      throw error;
    }
    this.sha = commit.sha;
    this.treeSha = tree.sha;
    for (const [path, content] of updates) {
      this.cache.set(path, content);
      // New blobs need no fetch within this run, but must appear in the file inventory.
      this.files.set(path, tree.tree.find(file => file.path === path)?.sha ?? 'cached');
    }
    return this.sha;
  }
}
