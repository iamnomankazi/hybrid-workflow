// Repo-relative path normalization shared by spec validation and patch validation.
// Canonical form: forward slashes, no leading "./", no trailing slash, no empty/"."/".." segments.
// Comparison elsewhere is case-insensitive because the target filesystem (NTFS) is.

export class RepoPathError extends Error {}

export function normalizeRepoPath(input) {
  if (typeof input !== 'string') throw new RepoPathError('path must be a string');
  let p = input.trim().replace(/\\/g, '/');
  if (!p) throw new RepoPathError('path is empty');
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.startsWith('//')) {
    throw new RepoPathError(`path must be repo-relative: ${input}`);
  }
  if (/[\0<>"|?*]/.test(p) || /[\x00-\x1f\x7f]/.test(p)) throw new RepoPathError(`path has invalid characters: ${input}`);
  // NTFS alternate data streams ("file:stream") are never legitimate here.
  if (p.includes(':')) throw new RepoPathError(`path must not contain ':': ${input}`);
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/+$/, '');
  const segments = p.split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') throw new RepoPathError(`path has an empty, '.' or '..' segment: ${input}`);
    // Windows silently strips trailing dots/spaces, which would let "AGENTS.md." alias "AGENTS.md".
    if (/[. ]$/.test(s)) throw new RepoPathError(`path segment ends with '.' or space: ${input}`);
    // DOS device names resolve to devices, not files, in any directory and with any extension.
    if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(s)) {
      throw new RepoPathError(`path segment is a reserved Windows device name: ${input}`);
    }
  }
  return segments.join('/');
}

// Scope entries: "dir/" or "dir" match the subtree, "file.ext" matches itself (and a subtree
// of the same name, which is harmless). "." or "*" would mean the whole repo; rejected so that
// whole-repo write access is always spelled out deliberately as "**".
export function normalizeScopeEntries(entries) {
  if (!Array.isArray(entries)) throw new RepoPathError('scope must be an array of paths');
  const out = [];
  for (const e of entries) {
    if (e === '**') {
      out.push('**');
      continue;
    }
    out.push(normalizeRepoPath(e));
  }
  return [...new Set(out)];
}

export function pathInScope(repoPath, scope) {
  const p = repoPath.toLowerCase();
  for (const entry of scope) {
    if (entry === '**') return true;
    const e = entry.toLowerCase();
    if (p === e || p.startsWith(`${e}/`)) return true;
  }
  return false;
}
