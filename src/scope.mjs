// Validation of a captured change set: protected paths, write scope, symlink/gitlink modes and
// on-disk reparse points. Path matching is case-insensitive because the target filesystem is.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRepoPath, normalizeScopeEntries, pathInScope } from './repopath.mjs';

// Documented protected set (docs/ARCHITECTURE.md section 10). Matching happens in protectedRule.
export const PROTECTED_RULES = Object.freeze({
  git_internal: Object.freeze({ allowable: false, segments: ['.git'] }),
  protected: Object.freeze({
    allowable: true,
    basenames: ['.gitmodules', '.gitattributes', 'agents.md', 'claude.md', 'codex.md'],
    segments: ['.husky', '.githooks', '.claude', '.codex', '.agents'],
    subtrees: ['.github/workflows'],
  }),
});

// NTFS 8.3 short names alias the dot-directories ("GIT~1" opens ".git"), so they get the same rule.
const SHORT_NAME_GIT = /^git~\d+$/;
const SHORT_NAME_PROTECTED = /^(gitmod~\d+|gitatt~\d+)$/;

export function protectedRule(repoPath) {
  const segments = repoPath.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  const base = segments[segments.length - 1] ?? '';

  for (const seg of segments) {
    if (PROTECTED_RULES.git_internal.segments.includes(seg) || SHORT_NAME_GIT.test(seg)) {
      return { rule: 'git_internal', allowable: false, detail: `path is inside git internals (${seg})` };
    }
  }
  const p = PROTECTED_RULES.protected;
  if (p.basenames.includes(base) || SHORT_NAME_PROTECTED.test(base)) {
    return { rule: 'protected', allowable: true, detail: `protected file name (${base})` };
  }
  for (const seg of segments) {
    if (p.segments.includes(seg)) {
      return { rule: 'protected', allowable: true, detail: `protected directory (${seg}/)` };
    }
  }
  for (let i = 0; i + 1 < segments.length; i++) {
    if (`${segments[i]}/${segments[i + 1]}` === '.github/workflows') {
      return { rule: 'protected', allowable: true, detail: 'protected directory (.github/workflows/)' };
    }
  }
  return null;
}

export function validateChanges(files, { sandbox, writeScope, allowProtected = [], allowSymlinks = false } = {}) {
  const scope = normalizeScopeEntries(writeScope ?? []);
  const allowed = normalizeScopeEntries(allowProtected);
  const violations = [];

  for (const file of files) {
    let p;
    try {
      p = normalizeRepoPath(file.path);
    } catch (err) {
      violations.push({ path: file.path, rule: 'invalid_path', detail: err.message });
      continue;
    }
    const add = (rule, detail) => violations.push({ path: p, rule, detail });

    if (sandbox === 'read-only') {
      add('read_only_job_modified', 'read-only job produced a change');
      continue;
    }

    const prot = protectedRule(p);
    if (prot && !(prot.allowable && pathInScope(p, allowed))) {
      add(prot.rule, prot.detail);
    }
    if (!pathInScope(p, scope)) add('outside_write_scope', 'path is not covered by write_scope');

    const modes = [file.old_mode, file.new_mode];
    if (modes.includes('160000')) add('gitlink', 'submodule/gitlink entries are never allowed');
    if (modes.includes('120000') && !allowSymlinks) add('symlink', 'symlinks require allow_symlinks');
  }

  const verdict = violations.length > 0 ? 'violations' : files.length === 0 ? 'empty' : 'clean';
  return { verdict, violations };
}

// Symlinks and junctions (Node reports both as symbolic links) on a changed path or on any
// directory above it would let a change land outside the worktree. Never followed.
export function findReparsePoints(worktree, repoPaths) {
  const found = new Map();
  for (const raw of repoPaths) {
    let p;
    try {
      p = normalizeRepoPath(raw);
    } catch {
      continue; // reported as invalid_path by validateChanges
    }
    const segments = p.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const rel = segments.slice(0, i).join('/');
      let st;
      try {
        st = fs.lstatSync(path.join(worktree, ...segments.slice(0, i)));
      } catch {
        break; // nothing at or below this point exists on disk
      }
      if (st.isSymbolicLink()) {
        if (!found.has(rel.toLowerCase())) {
          found.set(rel.toLowerCase(), {
            path: rel,
            rule: 'reparse_point',
            detail: rel === p ? 'changed path is a symlink/junction' : `ancestor of changed path ${p} is a symlink/junction`,
          });
        }
        break;
      }
    }
  }
  return [...found.values()];
}
