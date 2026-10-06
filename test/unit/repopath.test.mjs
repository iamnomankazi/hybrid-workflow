import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoPath, normalizeScopeEntries, pathInScope, RepoPathError } from '../../src/repopath.mjs';

const rejects = (input) => assert.throws(() => normalizeRepoPath(input), RepoPathError, JSON.stringify(input));

describe('normalizeRepoPath: accepts', () => {
  test('simple relative paths', () => {
    assert.equal(normalizeRepoPath('a/b'), 'a/b');
    assert.equal(normalizeRepoPath('file.txt'), 'file.txt');
    assert.equal(normalizeRepoPath('src/deep/er/x.mjs'), 'src/deep/er/x.mjs');
  });

  test('backslashes become forward slashes', () => {
    assert.equal(normalizeRepoPath('.\\a\\b'), 'a/b');
    assert.equal(normalizeRepoPath('a\\b\\c.txt'), 'a/b/c.txt');
    assert.equal(normalizeRepoPath('a/b\\c'), 'a/b/c');
  });

  test('leading ./ (repeated) is stripped', () => {
    assert.equal(normalizeRepoPath('./a'), 'a');
    assert.equal(normalizeRepoPath('././a/b'), 'a/b');
  });

  test('trailing slashes are stripped', () => {
    assert.equal(normalizeRepoPath('a/b/'), 'a/b');
    assert.equal(normalizeRepoPath('a/b///'), 'a/b');
    assert.equal(normalizeRepoPath('a\\b\\'), 'a/b');
  });

  test('surrounding whitespace is trimmed', () => {
    assert.equal(normalizeRepoPath('  a/b  '), 'a/b');
    assert.equal(normalizeRepoPath('\ta/b\n'), 'a/b');
  });

  test('dotfiles, spaces inside names, and unicode are fine', () => {
    assert.equal(normalizeRepoPath('.github/workflows/ci.yml'), '.github/workflows/ci.yml');
    assert.equal(normalizeRepoPath('my dir/my file.txt'), 'my dir/my file.txt');
    assert.equal(normalizeRepoPath('dir/\u0444\u0430\u0439\u043b.txt'), 'dir/\u0444\u0430\u0439\u043b.txt');
    assert.equal(normalizeRepoPath('a/.hidden'), 'a/.hidden');
    assert.equal(normalizeRepoPath('..a/b'), '..a/b');
    assert.equal(normalizeRepoPath('a/b..c'), 'a/b..c');
  });

  test('case is preserved (comparison, not normalization, is case-insensitive)', () => {
    assert.equal(normalizeRepoPath('Src/Main.MJS'), 'Src/Main.MJS');
  });

  test('is idempotent', () => {
    for (const p of ['a/b', '.\\a\\b\\', './x/y/']) {
      const once = normalizeRepoPath(p);
      assert.equal(normalizeRepoPath(once), once);
    }
  });
});

describe('normalizeRepoPath: rejects', () => {
  test('non-strings', () => {
    for (const v of [undefined, null, 5, {}, [], ['a']]) rejects(v);
  });

  test('empty / whitespace-only / only dot-slash', () => {
    for (const v of ['', '   ', '\t', './', '.\\', '././']) rejects(v);
  });

  test('absolute paths: drive, rooted, UNC', () => {
    for (const v of ['C:\\x', 'C:/x', 'c:x', 'D:\\', '/x', '/', '\\x', '\\\\server\\share', '//server/share', '\\\\?\\C:\\x']) {
      rejects(v);
    }
  });

  test('".." anywhere', () => {
    for (const v of ['..', '../a', 'a/..', 'a/../b', '..\\a', 'a\\..\\b', './../a']) rejects(v);
  });

  test('"." segments after the first', () => {
    for (const v of ['a/./b', 'a/.', '.']) rejects(v);
  });

  test('empty segments', () => {
    for (const v of ['a//b', 'a\\\\b', 'a/\\b']) rejects(v);
  });

  test('colon (NTFS alternate data streams)', () => {
    for (const v of ['file.txt:stream', 'a/b:c', 'AGENTS.md::$DATA', 'a/b.txt:$DATA']) rejects(v);
  });

  test('trailing dot / space segments (Windows aliasing)', () => {
    for (const v of ['AGENTS.md.', 'dir /x', 'dir./x', 'a/b.', 'a/b /c', 'a/b. ./c', 'a/..../b']) rejects(v);
  });

  test('control characters', () => {
    for (let c = 0; c < 0x20; c++) {
      const ch = String.fromCharCode(c);
      // leading/trailing whitespace is trimmed by design, so embed the char in the middle
      rejects(`a${ch}b`);
    }
    rejects('a\u0000');
  });

  test('wildcard and reserved characters * ? < > | "', () => {
    for (const ch of ['*', '?', '<', '>', '|', '"']) {
      rejects(`a${ch}b`);
      rejects(`dir/${ch}`);
      rejects(`${ch}`);
    }
  });

  test('error is a RepoPathError with a useful message', () => {
    try {
      normalizeRepoPath('../x');
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof RepoPathError);
      assert.ok(err instanceof Error);
      assert.match(err.message, /\.\./);
    }
  });
});

describe('normalizeRepoPath: questionable inputs (pinned)', () => {
  test('DEL (0x7f) is not rejected as a control char', () => {
    rejects('a\u007fb');
  });

  test('"CON"/"NUL"/"AUX" reserved device names are not rejected', () => {
    rejects('a/nul');
    rejects('CON');
  });

  test('NTFS 8.3 short names are not rejected by normalizeRepoPath (scope.mjs handles GIT~1)', () => {
    assert.equal(normalizeRepoPath('AGENTS~1.MD'), 'AGENTS~1.MD');
  });
});

describe('normalizeScopeEntries', () => {
  test('dedups and normalizes', () => {
    assert.deepEqual(normalizeScopeEntries(['a/b', './a/b', 'a\\b', 'a/b/']), ['a/b']);
  });

  test('keeps ** and dedups it', () => {
    assert.deepEqual(normalizeScopeEntries(['**']), ['**']);
    assert.deepEqual(normalizeScopeEntries(['**', 'src', '**']), ['**', 'src']);
  });

  test('preserves first-seen order', () => {
    assert.deepEqual(normalizeScopeEntries(['z', 'a', 'z', 'm']), ['z', 'a', 'm']);
  });

  test('empty array is fine', () => {
    assert.deepEqual(normalizeScopeEntries([]), []);
  });

  test('rejects non-arrays', () => {
    for (const v of [undefined, null, 'src', {}, 5]) {
      assert.throws(() => normalizeScopeEntries(v), RepoPathError);
    }
  });

  test('rejects whole-repo spellings other than **', () => {
    for (const bad of ['.', './', '*', '/', '', '*/', 'src/*', '**/x', '***']) {
      assert.throws(() => normalizeScopeEntries([bad]), RepoPathError, JSON.stringify(bad));
    }
  });

  test('rejects any bad entry in the list', () => {
    assert.throws(() => normalizeScopeEntries(['ok', '../no']), RepoPathError);
    assert.throws(() => normalizeScopeEntries(['ok', 5]), RepoPathError);
    assert.throws(() => normalizeScopeEntries(['ok', null]), RepoPathError);
  });

  test('dedup is case-sensitive although matching is case-insensitive (pinned)', () => {
    // Harmless: both entries behave identically in pathInScope. Pin so a change is deliberate.
    assert.deepEqual(normalizeScopeEntries(['Src', 'src']), ['Src', 'src']);
  });
});

describe('pathInScope', () => {
  test('directory subtree', () => {
    assert.equal(pathInScope('src/a.mjs', ['src']), true);
    assert.equal(pathInScope('src/deep/er/a.mjs', ['src']), true);
  });

  test('exact file', () => {
    assert.equal(pathInScope('README.md', ['README.md']), true);
    assert.equal(pathInScope('docs/a.md', ['docs/a.md']), true);
    assert.equal(pathInScope('docs/a.md.bak', ['docs/a.md']), false);
    assert.equal(pathInScope('docs/b.md', ['docs/a.md']), false);
  });

  test('case-insensitive on both sides', () => {
    assert.equal(pathInScope('SRC/Main.mjs', ['src']), true);
    assert.equal(pathInScope('src/main.mjs', ['SRC']), true);
    assert.equal(pathInScope('readme.MD', ['README.md']), true);
  });

  test('prefix of a sibling name does not match', () => {
    assert.equal(pathInScope('srcx/file', ['src']), false);
    assert.equal(pathInScope('src-old/file', ['src']), false);
    assert.equal(pathInScope('src2', ['src']), false);
    assert.equal(pathInScope('a/srcx/file', ['src']), false);
  });

  test('scope is anchored at the repo root, not any depth', () => {
    assert.equal(pathInScope('lib/src/a.mjs', ['src']), false);
  });

  test('** matches everything', () => {
    assert.equal(pathInScope('anything/at/all.txt', ['**']), true);
    assert.equal(pathInScope('x', ['src', '**']), true);
    assert.equal(pathInScope('.git/config', ['**']), true); // protected paths are scope.mjs's job
  });

  test('empty scope matches nothing', () => {
    assert.equal(pathInScope('a', []), false);
  });

  test('any entry may match', () => {
    assert.equal(pathInScope('docs/x.md', ['src', 'docs']), true);
    assert.equal(pathInScope('test/x.md', ['src', 'docs']), false);
  });

  test('nested entry does not grant its parent', () => {
    assert.equal(pathInScope('src', ['src/lib']), false);
    assert.equal(pathInScope('src/other.mjs', ['src/lib']), false);
    assert.equal(pathInScope('src/lib/a.mjs', ['src/lib']), true);
  });

  test('works with normalized entries end to end', () => {
    const scope = normalizeScopeEntries(['.\\Src\\', 'README.md']);
    assert.equal(pathInScope('src/a.mjs', scope), true);
    assert.equal(pathInScope('readme.md', scope), true);
    assert.equal(pathInScope('other/a', scope), false);
  });

  test('a trailing-slash scope entry that was not normalized would never match (callers must normalize)', () => {
    assert.equal(pathInScope('src/a.mjs', ['src/']), false);
  });

  test('dotted-case folding: Turkish dotless/dotted I does not leak extra matches', () => {
    assert.equal(pathInScope('\u0130/x', ['i']), false);
  });
});
