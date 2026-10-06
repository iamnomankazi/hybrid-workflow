// Git wrapper, worktree lifecycle and change capture. Every call goes through runGit so hooks,
// fsmonitor and quoting behave identically everywhere; nothing here ever spawns a shell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { ensureDir, randomHex, sha256, writeFileAtomic } from './fsutil.mjs';
import { SHA1_RE } from './constants.mjs';

const DEFAULT_MAX_BUFFER = 512 * 1024 * 1024;
// Inherited repository-selection variables would silently redirect git to another repo/index.
const STRIPPED_ENV = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']);

export function resolveGitExe(env = process.env) {
  const sysRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  const whereExe = path.join(sysRoot, 'System32', 'where.exe');
  let out;
  try {
    out = execFileSync(whereExe, ['git'], { encoding: 'utf8', windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(`git.exe not found on PATH (where.exe git failed: ${err.message.split('\n')[0]})`);
  }
  const found = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((p) => path.isAbsolute(p));
  if (found.length === 0) throw new Error('git.exe not found on PATH');
  const cmd = found.find((p) => /[\\/]cmd[\\/]git\.exe$/i.test(p));
  return cmd ?? found[0];
}

// Directories Git for Windows needs on PATH (git itself plus its bundled sh/coreutils).
export function gitInstallDirs(gitExe) {
  const m = /^(.*)[\\/](?:cmd|mingw64[\\/]bin|bin)[\\/]git\.exe$/i.exec(gitExe);
  if (!m) return [];
  const root = m[1];
  return [path.join(root, 'cmd'), path.join(root, 'mingw64', 'bin'), path.join(root, 'usr', 'bin')]
    .filter((d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
}

// core.hooksPath pointing at a non-empty directory would still execute whatever is in it.
export function ensureEmptyHooksDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const entries = fs.readdirSync(dir);
  if (entries.length > 0) {
    throw new Error(`Hooks directory must be empty (it would execute hooks): ${dir} contains ${entries.join(', ')}`);
  }
  return dir;
}

// process.env minus the repository-selection variables, then `extra` on top.
export function cleanGitEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!STRIPPED_ENV.has(k.toUpperCase())) env[k] = v;
  }
  return { ...env, ...extra };
}

export function runGit(ctx, args, opts = {}) {
  const { cwd, env, input, encoding = 'utf8', allowFail = false, maxBuffer = DEFAULT_MAX_BUFFER } = opts;
  const fullArgs = [
    '-c', `core.hooksPath=${ctx.hooksDir}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.quotepath=false',
    ...args,
  ];
  const baseEnv = env ?? cleanGitEnv();
  const res = spawnSync(ctx.gitExe, fullArgs, {
    cwd,
    env: { ...baseEnv, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    input,
    encoding,
    maxBuffer,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const describe = () => `git ${args.join(' ')}`.slice(0, 300);
  if (res.error) throw new Error(`${describe()} could not run: ${res.error.message}`);
  const toText = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : (v ?? ''));
  if (res.status !== 0 && !allowFail) {
    throw new Error(`${describe()} failed (exit ${res.status}${res.signal ? `, ${res.signal}` : ''}): ${toText(res.stderr).trim().slice(0, 2000)}`);
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

export function gitVersion(ctx) {
  return runGit(ctx, ['--version']).stdout.trim();
}

export function repoTopLevel(ctx, dir) {
  const out = runGit(ctx, ['rev-parse', '--show-toplevel'], { cwd: dir }).stdout.trim();
  return path.resolve(out);
}

export function resolveCommit(ctx, repo, ref) {
  const res = runGit(ctx, ['-C', repo, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { allowFail: true });
  const sha = res.stdout.trim();
  if (res.status !== 0 || !SHA1_RE.test(sha)) throw new Error(`Not a commit in ${repo}: ${ref}`);
  return sha;
}

export function commitExists(ctx, repo, sha) {
  if (!SHA1_RE.test(sha)) return false;
  return runGit(ctx, ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], { allowFail: true }).status === 0;
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

export function createWorktree(ctx, { repo, worktree, baseCommit }) {
  if (!SHA1_RE.test(baseCommit)) throw new Error(`baseCommit must be a full 40-hex sha: ${baseCommit}`);
  if (lstatOrNull(worktree)) throw new Error(`Worktree path already exists: ${worktree}`);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  runGit(ctx, ['-C', repo, 'worktree', 'add', '--detach', worktree, baseCommit]);
  const head = runGit(ctx, ['rev-parse', 'HEAD'], { cwd: worktree }).stdout.trim();
  if (head !== baseCommit) throw new Error(`Worktree HEAD ${head} does not match base ${baseCommit}`);
}

export function prepareWorktree(ctx, { repo, worktree, prepare = {} }) {
  const result = { node_modules: 'none' };
  if (prepare.node_modules !== 'junction') return result;
  const source = path.join(repo, 'node_modules');
  const target = path.join(worktree, 'node_modules');
  const srcStat = lstatOrNull(source);
  if (!srcStat) return { node_modules: 'skipped:source_missing' };
  if (lstatOrNull(target)) return { node_modules: 'skipped:target_exists' };
  // Trailing slash: a directory-only rule ("node_modules/") only matches when git treats the
  // path as a directory, and the path does not exist in the fresh worktree yet.
  const ignored = runGit(ctx, ['check-ignore', '-q', 'node_modules/'], { cwd: worktree, allowFail: true });
  if (ignored.status !== 0) return { node_modules: 'skipped:not_git_ignored' };
  fs.symlinkSync(source, target, 'junction');
  return { node_modules: 'junction' };
}

// Unlink (never recurse through) every junction/symlink anywhere in the worktree so a later
// recursive delete cannot reach the repository (or anything else) they point at. Node reports
// junctions as symbolic links on Windows. Links are detected with lstat and never descended into.
function unlinkReparsePoints(worktree) {
  let unlinked = 0;
  const walk = (dir) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
      throw err;
    }
    for (const name of names) {
      const p = path.join(dir, name);
      const st = lstatOrNull(p);
      if (!st) continue;
      if (st.isSymbolicLink()) {
        fs.unlinkSync(p);
        unlinked++;
      } else if (st.isDirectory()) {
        walk(p);
      }
    }
  };
  walk(worktree);
  return unlinked;
}

export function removeWorktree(ctx, { repo, worktree }) {
  const prune = () => runGit(ctx, ['-C', repo, 'worktree', 'prune'], { allowFail: true });
  if (!lstatOrNull(worktree)) {
    prune();
    return { removed: false, detail: 'worktree path does not exist' };
  }
  const unlinked = unlinkReparsePoints(worktree);
  const res = runGit(ctx, ['-C', repo, 'worktree', 'remove', '--force', worktree], { allowFail: true });
  const stillThere = lstatOrNull(worktree) !== null;
  prune();
  const notes = [];
  if (unlinked) notes.push(`unlinked ${unlinked} link(s)`);
  if (res.status !== 0) notes.push(`git worktree remove exit ${res.status}: ${String(res.stderr ?? '').trim().slice(0, 500)}`);
  if (stillThere) notes.push('worktree directory still exists after removal');
  return { removed: !stillThere, detail: notes.join('; ') || 'removed' };
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function parseRaw(buf) {
  const tokens = buf.toString('utf8').split('\0');
  const records = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([A-Z])\d*$/.exec(tokens[i]);
    if (!m) continue;
    records.push({ path: tokens[++i], status: m[5], old_mode: m[1], new_mode: m[2] });
  }
  return records;
}

function parseNumstat(buf) {
  const map = new Map();
  for (const tok of buf.toString('utf8').split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(tok);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    map.set(m[3], { added: binary ? null : Number(m[1]), deleted: binary ? null : Number(m[2]), binary });
  }
  return map;
}

export function capturePatch(ctx, { worktree, baseCommit, patchFile, tmpDir = os.tmpdir() }) {
  if (!SHA1_RE.test(baseCommit)) throw new Error(`baseCommit must be a full 40-hex sha: ${baseCommit}`);
  if (isInside(worktree, tmpDir)) throw new Error(`tmpDir must be outside the worktree: ${tmpDir}`);
  ensureDir(tmpDir);
  const tmpIndex = path.join(tmpDir, `index-${randomHex(6)}`);
  const env = cleanGitEnv({ GIT_INDEX_FILE: tmpIndex });
  const opts = { cwd: worktree, env };
  try {
    // Always rebuilt from the base tree: the worker's own index may carry skip-worktree or
    // assume-unchanged bits that would hide modified files from `add -A`.
    runGit(ctx, ['read-tree', baseCommit], opts);
    runGit(ctx, ['add', '-A'], opts);

    const patch = runGit(ctx, [
      'diff', '--cached', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv',
      '--no-color', '--src-prefix=a/', '--dst-prefix=b/', baseCommit,
    ], { ...opts, encoding: 'buffer' }).stdout;
    const raw = runGit(ctx, ['diff', '--cached', '--raw', '-z', '--no-renames', '--abbrev=40', baseCommit], { ...opts, encoding: 'buffer' }).stdout;
    const numstat = runGit(ctx, ['diff', '--cached', '--numstat', '-z', '--no-renames', baseCommit], { ...opts, encoding: 'buffer' }).stdout;

    writeFileAtomic(patchFile, patch);
    const counts = parseNumstat(numstat);
    const parsed = parseRaw(raw);
    if (patch.length > 0 && parsed.length === 0) {
      throw new Error('patch is non-empty but no changed files were parsed from --raw output (format drift?)');
    }
    const files = parsed.map((r) => {
      const n = counts.get(r.path);
      if (!n) throw new Error(`numstat has no entry for changed path: ${r.path}`);
      return { path: r.path, status: r.status, old_mode: r.old_mode, new_mode: r.new_mode, added: n.added, deleted: n.deleted, binary: n.binary };
    });
    const stats = {
      files: files.length,
      added: files.reduce((s, f) => s + (f.added ?? 0), 0),
      deleted: files.reduce((s, f) => s + (f.deleted ?? 0), 0),
    };
    return { sha256: sha256(patch), bytes: patch.length, files, stats };
  } finally {
    try { fs.rmSync(tmpIndex, { force: true }); } catch { /* best effort */ }
  }
}
