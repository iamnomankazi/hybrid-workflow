import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { protectedRule, validateChanges, findReparsePoints } from '../../src/scope.mjs';

const f = (p, extra = {}) => ({ path: p, status: 'M', old_mode: '100644', new_mode: '100644', ...extra });
const rules = (res) => res.violations.map((v) => v.rule);

test('protectedRule: .git at any depth is never allowable', () => {
  for (const p of ['.git/config', 'a/.git/config', 'a/b/.GIT/hooks/pre-commit', '.git', 'sub/.Git']) {
    const r = protectedRule(p);
    assert.equal(r?.rule, 'git_internal', p);
    assert.equal(r.allowable, false, p);
  }
  assert.equal(protectedRule('GIT~1/config')?.rule, 'git_internal');
});

test('protectedRule: protected names, directories and case variants', () => {
  const protectedPaths = [
    '.gitmodules', 'sub/.GitModules', '.gitattributes', 'a/b/.gitattributes',
    '.github/workflows/ci.yml', '.GitHub/Workflows/x.yml', 'pkg/.github/workflows/deep/x.yml',
    '.husky/pre-commit', 'a/.githooks/x', '.claude/settings.json', 'x/.CLAUDE/y',
    '.codex/config.toml', '.agents/a', 'AGENTS.md', 'sub/AGENTS.md', 'sub/agents.MD',
    'CLAUDE.md', 'a/claude.md', 'CODEX.md', 'a/b/Codex.md',
  ];
  for (const p of protectedPaths) {
    const r = protectedRule(p);
    assert.equal(r?.rule, 'protected', p);
    assert.equal(r.allowable, true, p);
  }
});

test('protectedRule: ordinary paths are not protected', () => {
  for (const p of ['src/a.js', 'docs/AGENTS.md.txt', '.github/ISSUE_TEMPLATE/x.md', '.github/workflow/x', '.gitignore', 'my.git/x', 'agents/a.md']) {
    assert.equal(protectedRule(p), null, p);
  }
});

test('validateChanges: protected path needs allowProtected, .git never allowed', () => {
  const scope = { sandbox: 'workspace-write', writeScope: ['**'] };
  assert.deepEqual(rules(validateChanges([f('AGENTS.md')], scope)), ['protected']);
  // allow entries use path-scope semantics: a root entry does not cover a nested file
  assert.deepEqual(rules(validateChanges([f('sub/AGENTS.md')], { ...scope, allowProtected: ['AGENTS.md'] })), ['protected']);
  assert.deepEqual(rules(validateChanges([f('sub/AGENTS.md')], { ...scope, allowProtected: ['sub/AGENTS.md'] })), []);
  assert.equal(validateChanges([f('AGENTS.md')], { ...scope, allowProtected: ['AGENTS.md'] }).verdict, 'clean');
  // allowing a different protected path does not allow this one
  assert.deepEqual(rules(validateChanges([f('CLAUDE.md')], { ...scope, allowProtected: ['AGENTS.md'] })), ['protected']);
  // subtree allow entry
  assert.equal(validateChanges([f('.github/workflows/ci.yml')], { ...scope, allowProtected: ['.github/workflows'] }).verdict, 'clean');
  // .git can never be allowed, even with a broad entry
  for (const allow of [['.git'], ['a/.git/config'], ['**'], ['a']]) {
    const res = validateChanges([f('a/.git/config')], { ...scope, allowProtected: allow });
    assert.deepEqual(rules(res), ['git_internal'], JSON.stringify(allow));
  }
});

test('validateChanges: write scope directory and file semantics', () => {
  const opts = { sandbox: 'workspace-write', writeScope: ['src/', 'README.md'] };
  assert.equal(validateChanges([f('src/a.js'), f('src/deep/b.js'), f('SRC/c.js'), f('README.md')], opts).verdict, 'clean');
  const res = validateChanges([f('srcx/a.js'), f('README.md.bak'), f('other/x'), f('src')], opts);
  assert.deepEqual(res.violations.map((v) => [v.path, v.rule]), [
    ['srcx/a.js', 'outside_write_scope'],
    ['README.md.bak', 'outside_write_scope'],
    ['other/x', 'outside_write_scope'],
  ]);
  assert.equal(validateChanges([f('anything/at/all')], { sandbox: 'workspace-write', writeScope: ['**'] }).verdict, 'clean');
  assert.equal(validateChanges([f('x')], { sandbox: 'workspace-write', writeScope: [] }).verdict, 'violations');
});

test('validateChanges: multiple violations per file', () => {
  const res = validateChanges([f('.claude/x', { new_mode: '120000' })], { sandbox: 'workspace-write', writeScope: ['src/'] });
  assert.deepEqual(rules(res).sort(), ['outside_write_scope', 'protected', 'symlink']);
});

test('validateChanges: read-only job must not change anything', () => {
  const res = validateChanges([f('src/a.js'), f('b.txt')], { sandbox: 'read-only', writeScope: ['**'] });
  assert.equal(res.verdict, 'violations');
  assert.deepEqual(rules(res), ['read_only_job_modified', 'read_only_job_modified']);
  assert.equal(validateChanges([], { sandbox: 'read-only', writeScope: [] }).verdict, 'empty');
});

test('validateChanges: symlink and gitlink modes', () => {
  const base = { sandbox: 'workspace-write', writeScope: ['**'] };
  const link = f('l', { status: 'A', old_mode: '000000', new_mode: '120000' });
  assert.deepEqual(rules(validateChanges([link], base)), ['symlink']);
  assert.equal(validateChanges([link], { ...base, allowSymlinks: true }).verdict, 'clean');
  // deleting or replacing an existing symlink also counts
  assert.deepEqual(rules(validateChanges([f('l', { status: 'D', old_mode: '120000', new_mode: '000000' })], base)), ['symlink']);
  const sub = f('mod', { status: 'A', old_mode: '000000', new_mode: '160000' });
  assert.deepEqual(rules(validateChanges([sub], base)), ['gitlink']);
  assert.deepEqual(rules(validateChanges([sub], { ...base, allowSymlinks: true })), ['gitlink']);
});

test('validateChanges: invalid paths', () => {
  const base = { sandbox: 'workspace-write', writeScope: ['**'] };
  for (const bad of ['../x', 'C:/x', '/abs', 'a/../b', 'AGENTS.md.', 'a/b:stream', '', 'a//b', 'x<y']) {
    const res = validateChanges([f(bad)], base);
    assert.equal(res.verdict, 'violations', JSON.stringify(bad));
    assert.deepEqual(rules(res), ['invalid_path'], JSON.stringify(bad));
  }
});

test('validateChanges: verdicts', () => {
  const base = { sandbox: 'workspace-write', writeScope: ['src/'] };
  assert.equal(validateChanges([], base).verdict, 'empty');
  assert.equal(validateChanges([f('src/a')], base).verdict, 'clean');
  assert.equal(validateChanges([f('src/a'), f('b')], base).verdict, 'violations');
  assert.deepEqual(validateChanges([], base).violations, []);
});

test('findReparsePoints: detects symlinked changed paths and ancestors without following them', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hws-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hws-'));
  const cleanup = () => {
    for (const p of [path.join(root, 'linkdir'), path.join(root, 'sub', 'linkdir2')]) {
      try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* absent */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  };
  t.after(cleanup);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'real.txt'), 'y');
  fs.symlinkSync(outside, path.join(root, 'linkdir'), 'junction');
  fs.symlinkSync(outside, path.join(root, 'sub', 'linkdir2'), 'junction');

  const res = findReparsePoints(root, [
    'sub/real.txt', 'linkdir/secret.txt', 'linkdir/other.txt', 'sub/linkdir2', 'missing/none.txt', '../bad',
  ]);
  assert.deepEqual(res.map((v) => v.path).sort(), ['linkdir', 'sub/linkdir2']);
  assert.ok(res.every((v) => v.rule === 'reparse_point'));
  assert.ok(fs.existsSync(path.join(outside, 'secret.txt')));
});
