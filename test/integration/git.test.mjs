import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  resolveGitExe, gitInstallDirs, ensureEmptyHooksDir, runGit, gitVersion, repoTopLevel,
  resolveCommit, commitExists, createWorktree, prepareWorktree, removeWorktree, capturePatch,
} from '../../src/git.mjs';
import { sha256 } from '../../src/fsutil.mjs';

const UNICODE_FILE = 'sp ace/\u00fcn\u00efc\u00f6de.txt';

let root;
let ctx;
let repo;
let base;
const worktrees = [];

function git(args, opts = {}) {
  return runGit(ctx, args, opts).stdout.trim();
}

function wtPath(name) {
  return path.join(root, 'wt', name);
}

function newWorktree(name) {
  const wt = wtPath(name);
  createWorktree(ctx, { repo, worktree: wt, baseCommit: base });
  worktrees.push({ repo, wt });
  return wt;
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main', dir]);
  git(['-C', dir, 'config', 'user.name', 'Test User']);
  git(['-C', dir, 'config', 'user.email', 'test@example.invalid']);
  git(['-C', dir, 'config', 'core.autocrlf', 'false']);
  git(['-C', dir, 'config', 'commit.gpgsign', 'false']);
}

function commitAll(dir, message) {
  git(['-C', dir, 'add', '-A']);
  git(['-C', dir, 'commit', '-q', '-m', message]);
  return git(['-C', dir, 'rev-parse', 'HEAD']);
}

function indexPath(wt) {
  return path.resolve(wt, git(['rev-parse', '--git-path', 'index'], { cwd: wt }));
}

// Junctions must be unlinked before any recursive delete or it would follow into the target repo.
function unlinkLinks(dir) {
  const probe = (p) => {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
    } catch { /* absent */ }
  };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) probe(path.join(dir, n));
  try {
    for (const n of fs.readdirSync(path.join(dir, 'node_modules'))) probe(path.join(dir, 'node_modules', n));
  } catch { /* none */ }
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwg-'));
  const gitExe = resolveGitExe();
  const hooksDir = ensureEmptyHooksDir(path.join(root, 'hooks'));
  ctx = { gitExe, hooksDir };
  repo = path.join(root, 'repo');
  initRepo(repo);
  write(path.join(repo, '.gitignore'), 'ignored.txt\nnode_modules/\n');
  write(path.join(repo, 'a.txt'), 'line1\nline2\nline3\n');
  write(path.join(repo, 'b.txt'), 'to be deleted\n');
  write(path.join(repo, 'dir', 'c.txt'), 'c\n');
  write(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255, 254, 0, 10, 13, 0]));
  write(path.join(repo, UNICODE_FILE), 'unicode content\n');
  base = commitAll(repo, 'base');
  // node_modules is ignored and untracked: lives only in the main checkout.
  write(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
});

after(() => {
  for (const { repo: r, wt } of worktrees.reverse()) {
    try { removeWorktree(ctx, { repo: r, worktree: wt }); } catch { /* best effort */ }
    unlinkLinks(wt);
  }
  unlinkLinks(root);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('helpers', () => {
  test('resolveGitExe, gitInstallDirs, gitVersion', () => {
    assert.ok(path.isAbsolute(ctx.gitExe));
    assert.ok(fs.existsSync(ctx.gitExe));
    assert.match(ctx.gitExe, /git\.exe$/i);
    assert.match(gitVersion(ctx), /^git version \d+\./);
    const dirs = gitInstallDirs(ctx.gitExe);
    assert.ok(dirs.length >= 1);
    assert.ok(dirs.every((d) => fs.statSync(d).isDirectory()));
    assert.deepEqual(gitInstallDirs('C:\\nowhere\\foo.exe'), []);
    assert.deepEqual(gitInstallDirs('C:\\definitely-missing\\Git\\cmd\\git.exe'), []);
  });

  test('ensureEmptyHooksDir creates, accepts empty, throws on non-empty', () => {
    const dir = path.join(root, 'hooks-test');
    assert.equal(ensureEmptyHooksDir(dir), dir);
    assert.equal(ensureEmptyHooksDir(dir), dir);
    fs.writeFileSync(path.join(dir, 'pre-commit'), '#!/bin/sh\n');
    assert.throws(() => ensureEmptyHooksDir(dir), /empty/);
  });

  test('runGit: failure throws, allowFail reports status, repo-selecting env is stripped', () => {
    assert.throws(() => runGit(ctx, ['rev-parse', '--verify', 'nope-not-a-ref'], { cwd: repo }), /failed/);
    const res = runGit(ctx, ['rev-parse', '--verify', 'nope-not-a-ref'], { cwd: repo, allowFail: true });
    assert.notEqual(res.status, 0);
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = path.join(root, 'does-not-exist');
    process.env.GIT_WORK_TREE = path.join(root, 'does-not-exist');
    process.env.GIT_INDEX_FILE = path.join(root, 'does-not-exist-index');
    try {
      assert.equal(git(['rev-parse', 'HEAD'], { cwd: repo }), base);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  test('repoTopLevel returns an absolute Windows path', () => {
    fs.mkdirSync(path.join(repo, 'dir'), { recursive: true });
    const top = repoTopLevel(ctx, path.join(repo, 'dir'));
    assert.equal(top.toLowerCase(), path.resolve(repo).toLowerCase());
    assert.ok(!top.includes('/'));
  });

  test('resolveCommit and commitExists', () => {
    assert.equal(resolveCommit(ctx, repo, 'HEAD'), base);
    assert.equal(resolveCommit(ctx, repo, 'main'), base);
    assert.equal(resolveCommit(ctx, repo, base), base);
    for (const bad of ['garbage-ref', '--help', '-x', '', 'HEAD:a.txt']) {
      assert.throws(() => resolveCommit(ctx, repo, bad), /Not a commit/, JSON.stringify(bad));
    }
    // a tree is not a commit
    assert.throws(() => resolveCommit(ctx, repo, git(['-C', repo, 'rev-parse', 'HEAD^{tree}'])), /Not a commit/);
    assert.equal(commitExists(ctx, repo, base), true);
    assert.equal(commitExists(ctx, repo, '0'.repeat(40)), false);
    assert.equal(commitExists(ctx, repo, '--version'), false);
  });
});

describe('worktrees', () => {
  test('createWorktree creates a detached worktree at base and refuses an existing path', () => {
    const wt = newWorktree('create');
    assert.equal(git(['rev-parse', 'HEAD'], { cwd: wt }), base);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt }), 'HEAD');
    assert.equal(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'line1\nline2\nline3\n');
    assert.throws(() => createWorktree(ctx, { repo, worktree: wt, baseCommit: base }), /already exists/);
    const emptyDir = wtPath('exists-empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    assert.throws(() => createWorktree(ctx, { repo, worktree: emptyDir, baseCommit: base }), /already exists/);
    assert.throws(() => createWorktree(ctx, { repo, worktree: wtPath('badbase'), baseCommit: 'HEAD' }), /40-hex/);
  });

  test('hooks are disabled for worktree creation', () => {
    const marker = path.join(root, 'hook-ran.marker');
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    try {
      // control: without our hardening the hook does run, so the assertion below means something
      const control = wtPath('hook-control');
      execFileSync(ctx.gitExe, ['-C', repo, 'worktree', 'add', '--detach', control, base], { windowsHide: true, stdio: 'ignore' });
      worktrees.push({ repo, wt: control });
      assert.ok(fs.existsSync(marker), 'control: hook should have run with default hooksPath');
      fs.rmSync(marker);

      newWorktree('hook-guarded');
      assert.ok(!fs.existsSync(marker), 'post-checkout hook must not run through runGit');
    } finally {
      fs.rmSync(hook, { force: true });
    }
  });

  test('prepareWorktree: junction for ignored node_modules, removal never touches the source', () => {
    const wt = newWorktree('junction');
    assert.deepEqual(prepareWorktree(ctx, { repo, worktree: wt }), { node_modules: 'none' });
    assert.deepEqual(prepareWorktree(ctx, { repo, worktree: wt, prepare: { node_modules: 'none' } }), { node_modules: 'none' });

    const res = prepareWorktree(ctx, { repo, worktree: wt, prepare: { node_modules: 'junction' } });
    assert.deepEqual(res, { node_modules: 'junction' });
    assert.ok(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(wt, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;\n');
    // second call: target now exists
    assert.deepEqual(prepareWorktree(ctx, { repo, worktree: wt, prepare: { node_modules: 'junction' } }), { node_modules: 'skipped:target_exists' });

    // the junction is invisible to capture (ignored), so it cannot leak into a patch
    const cap = capturePatch(ctx, { worktree: wt, baseCommit: base, patchFile: path.join(root, 'junction.diff'), tmpDir: path.join(root, 'tmp') });
    assert.deepEqual(cap.files, []);

    // an extra top-level link must also be unlinked rather than recursed into
    const extraTarget = path.join(root, 'extra-target');
    write(path.join(extraTarget, 'keep.txt'), 'keep');
    fs.symlinkSync(extraTarget, path.join(wt, 'extra-link'), 'junction');

    const out = removeWorktree(ctx, { repo, worktree: wt });
    assert.equal(out.removed, true, out.detail);
    assert.ok(!fs.existsSync(wt));
    assert.ok(fs.existsSync(path.join(repo, 'node_modules', 'pkg', 'index.js')), 'source node_modules must survive');
    assert.ok(fs.existsSync(path.join(extraTarget, 'keep.txt')), 'extra junction target must survive');
    assert.ok(!git(['-C', repo, 'worktree', 'list', '--porcelain']).toLowerCase().includes(path.basename(wt).toLowerCase() + '\n'));
  });

  test('prepareWorktree: skipped when node_modules is not git-ignored or source is missing', () => {
    const repo2 = path.join(root, 'repo2');
    initRepo(repo2);
    write(path.join(repo2, 'x.txt'), 'x\n');
    const base2 = commitAll(repo2, 'base');
    write(path.join(repo2, 'node_modules', 'pkg', 'index.js'), '1\n'); // present but NOT ignored
    const wt = wtPath('notignored');
    createWorktree(ctx, { repo: repo2, worktree: wt, baseCommit: base2 });
    worktrees.push({ repo: repo2, wt });
    assert.deepEqual(prepareWorktree(ctx, { repo: repo2, worktree: wt, prepare: { node_modules: 'junction' } }), { node_modules: 'skipped:not_git_ignored' });
    assert.ok(!fs.existsSync(path.join(wt, 'node_modules')));

    fs.rmSync(path.join(repo2, 'node_modules'), { recursive: true });
    assert.deepEqual(prepareWorktree(ctx, { repo: repo2, worktree: wt, prepare: { node_modules: 'junction' } }), { node_modules: 'skipped:source_missing' });
  });

  test('removeWorktree unlinks a junction nested deep in the tree without following it', () => {
    const wt = newWorktree('nested-link');
    const target = path.join(root, 'nested-target');
    write(path.join(target, 'sentinel.txt'), 'sentinel');
    write(path.join(target, 'sub', 'deep.txt'), 'deep');
    write(path.join(wt, 'a', 'b', 'file.txt'), 'x');
    fs.symlinkSync(target, path.join(wt, 'a', 'b', 'link'), 'junction');
    const out = removeWorktree(ctx, { repo, worktree: wt });
    assert.equal(out.removed, true, out.detail);
    assert.match(out.detail, /unlinked 1 link/);
    assert.ok(!fs.existsSync(wt));
    assert.ok(fs.existsSync(path.join(target, 'sentinel.txt')));
    assert.ok(fs.existsSync(path.join(target, 'sub', 'deep.txt')));
  });

  test('removeWorktree on a missing path prunes and reports removed:false', () => {
    const out = removeWorktree(ctx, { repo, worktree: wtPath('never-existed') });
    assert.equal(out.removed, false);
  });

  test('removeWorktree prunes a worktree whose directory was deleted behind git\'s back', () => {
    const wt = newWorktree('vanished');
    fs.rmSync(wt, { recursive: true, force: true });
    assert.equal(removeWorktree(ctx, { repo, worktree: wt }).removed, false);
    assert.ok(!git(['-C', repo, 'worktree', 'list', '--porcelain']).includes('vanished'));
  });
});

describe('capturePatch', () => {
  let wt1;
  let tmpDir;
  let cap;
  let patchFile;
  let indexBefore;

  before(() => {
    wt1 = newWorktree('cap1');
    tmpDir = path.join(root, 'tmp');
    patchFile = path.join(root, 'cap1.diff');
    // tracked modifications (text and binary), deletion, and untracked/ignored additions
    fs.appendFileSync(path.join(wt1, 'a.txt'), 'line4 added\n');
    fs.rmSync(path.join(wt1, 'b.txt'));
    fs.writeFileSync(path.join(wt1, UNICODE_FILE), 'unicode content changed\n');
    write(path.join(wt1, 'bin.dat'), Buffer.from([0, 9, 9, 0, 1, 0]));
    write(path.join(wt1, 'new.txt'), 'brand new\n');
    write(path.join(wt1, 'nested', 'deeper', 'n.txt'), 'n1\nn2\n');
    write(path.join(wt1, 'new.bin'), Buffer.from([0, 0, 1, 2, 3, 0, 0]));
    write(path.join(wt1, 'sp ace', '\u00fcn\u00efc\u00f6de-new.txt'), 'new unicode\n');
    write(path.join(wt1, 'ignored.txt'), 'should never appear\n');
    write(path.join(wt1, 'nested', 'ignored.txt'), 'nor this\n');
    indexBefore = fs.readFileSync(indexPath(wt1));
    cap = capturePatch(ctx, { worktree: wt1, baseCommit: base, patchFile, tmpDir });
  });

  test('reports A/M/D files with untracked included and ignored excluded', () => {
    const byPath = new Map(cap.files.map((x) => [x.path, x]));
    const expectStatus = {
      'a.txt': 'M',
      'b.txt': 'D',
      [UNICODE_FILE]: 'M',
      'bin.dat': 'M',
      'new.txt': 'A',
      'nested/deeper/n.txt': 'A',
      'new.bin': 'A',
      'sp ace/\u00fcn\u00efc\u00f6de-new.txt': 'A',
    };
    assert.deepEqual([...byPath.keys()].sort(), Object.keys(expectStatus).sort());
    for (const [p, s] of Object.entries(expectStatus)) assert.equal(byPath.get(p).status, s, p);
    assert.ok(!byPath.has('ignored.txt') && !byPath.has('nested/ignored.txt'));

    assert.equal(byPath.get('a.txt').added, 1);
    assert.equal(byPath.get('a.txt').deleted, 0);
    assert.equal(byPath.get('b.txt').deleted, 1);
    assert.equal(byPath.get('b.txt').new_mode, '000000');
    assert.equal(byPath.get('new.txt').old_mode, '000000');
    assert.equal(byPath.get('new.txt').new_mode, '100644');
    assert.equal(byPath.get('nested/deeper/n.txt').added, 2);
    for (const p of ['bin.dat', 'new.bin']) {
      assert.equal(byPath.get(p).binary, true, p);
      assert.equal(byPath.get(p).added, null, p);
      assert.equal(byPath.get(p).deleted, null, p);
    }
    assert.equal(byPath.get('a.txt').binary, false);

    assert.equal(cap.stats.files, 8);
    assert.equal(cap.stats.added, 1 + 1 + 1 + 2 + 1);
    assert.equal(cap.stats.deleted, 1 + 1 /* b.txt, unicode line replaced */);
  });

  test('sha256 and bytes describe the exact patch file', () => {
    const bytes = fs.readFileSync(patchFile);
    assert.equal(cap.bytes, bytes.length);
    assert.equal(cap.sha256, sha256(bytes));
    assert.ok(bytes.length > 0);
    const text = bytes.toString('latin1');
    assert.match(text, /^diff --git a\/a\.txt b\/a\.txt/m);
    assert.match(text, /^GIT binary patch/m);
    assert.ok(!text.includes('should never appear'));
  });

  test('gold check: applying the patch to a fresh worktree yields the same tree', () => {
    const wt2 = newWorktree('cap-gold');
    git(['apply', '--index', '--binary', patchFile], { cwd: wt2 });
    const applied = git(['write-tree'], { cwd: wt2 });

    const goldIndex = path.join(root, 'gold-index');
    const env = { ...process.env, GIT_INDEX_FILE: goldIndex };
    delete env.GIT_DIR;
    git(['add', '-A'], { cwd: wt1, env });
    const expected = git(['write-tree'], { cwd: wt1, env });
    fs.rmSync(goldIndex, { force: true });

    assert.equal(applied, expected);
    assert.notEqual(applied, git(['rev-parse', `${base}^{tree}`], { cwd: repo }));
  });

  test('worker index is untouched and the temp index is removed', () => {
    assert.deepEqual(fs.readFileSync(indexPath(wt1)), indexBefore);
    assert.deepEqual(fs.readdirSync(tmpDir).filter((n) => n.startsWith('index-')), []);
    // and git still sees everything as unstaged/untracked from the worker's point of view
    const status = runGit(ctx, ['status', '--porcelain'], { cwd: wt1 }).stdout;
    assert.match(status, /^\?\? new\.txt$/m);
    assert.match(status, /^ M a\.txt$/m);
  });

  test('does not depend on the worktree having an index file', () => {
    const wt = newWorktree('cap-noindex');
    write(path.join(wt, 'only.txt'), 'only\n');
    fs.rmSync(indexPath(wt));
    const out = capturePatch(ctx, { worktree: wt, baseCommit: base, patchFile: path.join(root, 'noindex.diff'), tmpDir });
    assert.deepEqual(out.files.map((x) => [x.path, x.status]), [['only.txt', 'A']]);
  });

  test('skip-worktree and assume-unchanged bits in the worker index cannot hide changes', () => {
    const wt = newWorktree('cap-hidden');
    git(['update-index', '--skip-worktree', 'a.txt'], { cwd: wt });
    git(['update-index', '--assume-unchanged', 'dir/c.txt'], { cwd: wt });
    fs.appendFileSync(path.join(wt, 'a.txt'), 'hidden edit 1\n');
    fs.appendFileSync(path.join(wt, 'dir', 'c.txt'), 'hidden edit 2\n');
    // sanity: the worker's own git really is blind to both edits
    assert.equal(runGit(ctx, ['status', '--porcelain'], { cwd: wt }).stdout.trim(), '');
    const indexBytes = fs.readFileSync(indexPath(wt));
    const out = capturePatch(ctx, { worktree: wt, baseCommit: base, patchFile: path.join(root, 'hidden.diff'), tmpDir });
    assert.deepEqual(out.files.map((x) => [x.path, x.status]).sort(), [['a.txt', 'M'], ['dir/c.txt', 'M']]);
    assert.deepEqual(fs.readFileSync(indexPath(wt)), indexBytes);
  });

  test('empty change set yields a zero-byte patch', () => {
    const wt = newWorktree('cap-empty');
    const file = path.join(root, 'empty.diff');
    write(file, 'stale content from a previous run');
    const out = capturePatch(ctx, { worktree: wt, baseCommit: base, patchFile: file, tmpDir });
    assert.equal(out.bytes, 0);
    assert.deepEqual(out.files, []);
    assert.deepEqual(out.stats, { files: 0, added: 0, deleted: 0 });
    assert.equal(fs.statSync(file).size, 0);
    assert.equal(out.sha256, sha256(Buffer.alloc(0)));
  });

  test('refuses a tmpDir inside the worktree', () => {
    assert.throws(
      () => capturePatch(ctx, { worktree: wt1, baseCommit: base, patchFile: path.join(root, 'x.diff'), tmpDir: path.join(wt1, 'tmp') }),
      /outside the worktree/,
    );
    assert.throws(
      () => capturePatch(ctx, { worktree: wt1, baseCommit: base, patchFile: path.join(root, 'x.diff'), tmpDir: wt1 }),
      /outside the worktree/,
    );
    assert.ok(!fs.existsSync(path.join(wt1, 'tmp')));
  });

  test('a mode change and a nested repository are reported with their modes', () => {
    const wt = newWorktree('cap-modes');
    // a nested repo becomes a gitlink (160000) under `add -A`
    initRepo(path.join(wt, 'inner'));
    write(path.join(wt, 'inner', 'f.txt'), 'f\n');
    commitAll(path.join(wt, 'inner'), 'inner');
    const out = capturePatch(ctx, { worktree: wt, baseCommit: base, patchFile: path.join(root, 'modes.diff'), tmpDir });
    const inner = out.files.find((x) => x.path === 'inner');
    assert.ok(inner, JSON.stringify(out.files));
    assert.equal(inner.new_mode, '160000');
    assert.equal(inner.status, 'A');
  });
});
