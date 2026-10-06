import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  sleepSync, sleep, withRetry, nowIso, ensureDir, writeFileAtomic, writeJsonAtomic, writeFileExclusive,
  readText, readJson, exists, appendJsonl, readJsonlFrom, sha256, sha256File, fileSize, randomHex,
  truncateUtf8, tryCreateLock, withMutex,
} from '../../src/fsutil.mjs';

const FSUTIL_URL = pathToFileURL(path.resolve(import.meta.dirname, '../../src/fsutil.mjs')).href;

let root;
let counter = 0;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwc-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Fresh empty directory per test.
function dir() {
  const d = path.join(root, `t${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const tmpFiles = (d) => fs.readdirSync(d).filter((n) => n.endsWith('.tmp'));

// Run `node --input-type=module -e code -- ...args`; resolve with { code, stderr }.
function runChild(code, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, '--', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve({ code: exitCode, stderr }));
  });
}

describe('fsutil: small helpers', () => {
  test('nowIso is a UTC ISO-8601 string', () => {
    assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('ensureDir creates nested dirs, is idempotent and returns the dir', () => {
    const d = path.join(dir(), 'a', 'b', 'c');
    assert.equal(ensureDir(d), d);
    assert.equal(ensureDir(d), d);
    assert.ok(fs.statSync(d).isDirectory());
  });

  test('sleepSync blocks for roughly the requested time; sleep resolves later', async () => {
    const t0 = Date.now();
    sleepSync(60);
    assert.ok(Date.now() - t0 >= 50, 'sleepSync returned too early');
    const t1 = Date.now();
    await sleep(40);
    assert.ok(Date.now() - t1 >= 30);
  });

  test('randomHex length and charset', () => {
    assert.match(randomHex(4), /^[0-9a-f]{8}$/);
    assert.match(randomHex(2), /^[0-9a-f]{4}$/);
    assert.notEqual(randomHex(8), randomHex(8));
  });

  test('sha256 / sha256File agree with known vectors', () => {
    assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const f = path.join(dir(), 'x.bin');
    fs.writeFileSync(f, 'abc');
    assert.equal(sha256File(f), sha256('abc'));
    assert.equal(sha256(Buffer.from('abc')), sha256('abc'));
    assert.throws(() => sha256File(path.join(dir(), 'missing')), { code: 'ENOENT' });
  });

  test('exists and fileSize', () => {
    const d = dir();
    const f = path.join(d, 'f.txt');
    assert.equal(exists(f), false);
    assert.equal(fileSize(f), null);
    fs.writeFileSync(f, 'héllo');
    assert.equal(exists(f), true);
    assert.equal(exists(d), true);
    assert.equal(fileSize(f), Buffer.byteLength('héllo'));
  });
});

describe('fsutil: writeJsonAtomic / writeFileAtomic', () => {
  test('round trip including unicode, nesting and nulls', () => {
    const f = path.join(dir(), 'a.json');
    const value = { a: 1, b: [1, 2, { c: null }], s: 'café файл 😀', t: true };
    writeJsonAtomic(f, value);
    assert.deepEqual(readJson(f), value);
  });

  test('output is pretty-printed with a trailing newline', () => {
    const f = path.join(dir(), 'a.json');
    writeJsonAtomic(f, { a: 1 });
    assert.equal(fs.readFileSync(f, 'utf8'), '{\n  "a": 1\n}\n');
  });

  test('leaves no *.tmp files behind', () => {
    const d = dir();
    const f = path.join(d, 'a.json');
    for (let i = 0; i < 25; i++) writeJsonAtomic(f, { i });
    assert.deepEqual(tmpFiles(d), []);
    assert.deepEqual(fs.readdirSync(d), ['a.json']);
  });

  test('overwrites an existing file', () => {
    const f = path.join(dir(), 'a.json');
    writeJsonAtomic(f, { v: 1, big: 'x'.repeat(5000) });
    writeJsonAtomic(f, { v: 2 });
    assert.deepEqual(readJson(f), { v: 2 });
  });

  test('writeFileAtomic accepts Buffers and strings', () => {
    const d = dir();
    writeFileAtomic(path.join(d, 'b.bin'), Buffer.from([0, 1, 2, 255]));
    assert.deepEqual([...fs.readFileSync(path.join(d, 'b.bin'))], [0, 1, 2, 255]);
    writeFileAtomic(path.join(d, 't.txt'), 'hi');
    assert.equal(fs.readFileSync(path.join(d, 't.txt'), 'utf8'), 'hi');
  });

  test('missing parent directory throws ENOENT and leaves nothing', () => {
    const d = dir();
    assert.throws(() => writeJsonAtomic(path.join(d, 'nope', 'a.json'), {}), { code: 'ENOENT' });
    assert.deepEqual(fs.readdirSync(d), []);
  });

  test('when the rename cannot succeed the temp file is cleaned up and the error surfaces', () => {
    const d = dir();
    const target = path.join(d, 'target');
    fs.mkdirSync(target); // a directory cannot be replaced by a file
    assert.throws(() => writeJsonAtomic(target, { a: 1 }));
    assert.deepEqual(tmpFiles(d), []);
    assert.ok(fs.statSync(target).isDirectory());
  });

  test('writeJsonAtomic(undefined) must not write an invalid JSON document', () => {
    const f = path.join(dir(), 'u.json');
    let threw = false;
    try {
      writeJsonAtomic(f, undefined);
    } catch {
      threw = true;
    }
    if (!threw) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(f, 'utf8')));
  });
});

describe('fsutil: writeFileExclusive / tryCreateLock', () => {
  test('creates a new file', () => {
    const f = path.join(dir(), 'once.json');
    writeFileExclusive(f, 'one');
    assert.equal(fs.readFileSync(f, 'utf8'), 'one');
  });

  test('throws EEXIST and preserves the original content', () => {
    const f = path.join(dir(), 'once.json');
    writeFileExclusive(f, 'one');
    assert.throws(() => writeFileExclusive(f, 'two'), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(f, 'utf8'), 'one');
  });

  test('tryCreateLock true then false, content is the metadata', () => {
    const f = path.join(dir(), 'x.lock');
    assert.equal(tryCreateLock(f, { pid: 42 }), true);
    assert.equal(tryCreateLock(f, { pid: 43 }), false);
    assert.deepEqual(readJson(f), { pid: 42 });
  });

  test('tryCreateLock propagates non-EEXIST errors', () => {
    const f = path.join(dir(), 'missing-dir', 'x.lock');
    assert.throws(() => tryCreateLock(f, {}), { code: 'ENOENT' });
  });
});

describe('fsutil: readText / readJson', () => {
  test('optional missing returns null; required missing throws ENOENT', () => {
    const f = path.join(dir(), 'nope.json');
    assert.equal(readJson(f, { optional: true }), null);
    assert.equal(readText(f, { optional: true }), null);
    assert.throws(() => readJson(f), { code: 'ENOENT' });
    assert.throws(() => readText(f), { code: 'ENOENT' });
  });

  test('optional does not swallow other errors (reading a directory)', () => {
    const d = dir();
    assert.throws(() => readText(d, { optional: true }));
    assert.throws(() => readJson(d, { optional: true }));
  });

  test('UTF-8 BOM is tolerated', () => {
    const f = path.join(dir(), 'bom.json');
    fs.writeFileSync(f, '﻿{"a":1}');
    assert.deepEqual(readJson(f), { a: 1 });
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"b":2}')]));
    assert.deepEqual(readJson(f), { b: 2 });
  });

  test('CRLF and surrounding whitespace are tolerated', () => {
    const f = path.join(dir(), 'crlf.json');
    fs.writeFileSync(f, '\r\n{\r\n  "a": 1\r\n}\r\n');
    assert.deepEqual(readJson(f), { a: 1 });
  });

  test('invalid JSON error mentions the file', () => {
    const f = path.join(dir(), 'bad.json');
    fs.writeFileSync(f, '{"a":');
    assert.throws(() => readJson(f), (err) => {
      assert.ok(err.message.includes(f), err.message);
      assert.match(err.message, /Invalid JSON/);
      return true;
    });
  });

  test('optional file that exists but is invalid still throws', () => {
    const f = path.join(dir(), 'bad.json');
    fs.writeFileSync(f, 'nope');
    assert.throws(() => readJson(f, { optional: true }), /Invalid JSON/);
  });

  test('empty file is invalid JSON (not null)', () => {
    const f = path.join(dir(), 'empty.json');
    fs.writeFileSync(f, '');
    assert.throws(() => readJson(f), /Invalid JSON/);
    assert.throws(() => readJson(f, { optional: true }), /Invalid JSON/);
  });

  test('a file containing the JSON literal null reads as null', () => {
    const f = path.join(dir(), 'null.json');
    fs.writeFileSync(f, 'null\n');
    assert.equal(readJson(f), null);
  });
});

describe('fsutil: appendJsonl / readJsonlFrom', () => {
  test('append then read everything', () => {
    const f = path.join(dir(), 'e.jsonl');
    appendJsonl(f, { a: 1 });
    appendJsonl(f, { b: 'two' });
    const r = readJsonlFrom(f);
    assert.deepEqual(r.records, [{ a: 1 }, { b: 'two' }]);
    assert.equal(r.malformed, 0);
    assert.equal(r.nextOffset, fileSize(f));
  });

  test('records are single physical lines even when values contain newlines', () => {
    const f = path.join(dir(), 'e.jsonl');
    appendJsonl(f, { s: 'a\nb\r\nc' });
    assert.equal(fs.readFileSync(f, 'utf8').split('\n').length, 2);
    assert.deepEqual(readJsonlFrom(f).records, [{ s: 'a\nb\r\nc' }]);
  });

  test('missing file yields no records and keeps the offset', () => {
    const f = path.join(dir(), 'missing.jsonl');
    assert.deepEqual(readJsonlFrom(f), { records: [], nextOffset: 0, malformed: 0 });
    assert.deepEqual(readJsonlFrom(f, 17), { records: [], nextOffset: 17, malformed: 0 });
  });

  test('empty file', () => {
    const f = path.join(dir(), 'empty.jsonl');
    fs.writeFileSync(f, '');
    assert.deepEqual(readJsonlFrom(f), { records: [], nextOffset: 0, malformed: 0 });
  });

  test('partial trailing line is withheld, nextOffset stops before it, then it is returned once completed', () => {
    const f = path.join(dir(), 'p.jsonl');
    const first = '{"a":1}\n';
    fs.writeFileSync(f, `${first}{"b":`);
    const r1 = readJsonlFrom(f, 0);
    assert.deepEqual(r1.records, [{ a: 1 }]);
    assert.equal(r1.nextOffset, Buffer.byteLength(first));
    assert.equal(r1.malformed, 0);

    // Nothing new yet: same offset, no records.
    const r1b = readJsonlFrom(f, r1.nextOffset);
    assert.deepEqual(r1b, { records: [], nextOffset: r1.nextOffset, malformed: 0 });

    fs.appendFileSync(f, '2}\n');
    const r2 = readJsonlFrom(f, r1.nextOffset);
    assert.deepEqual(r2.records, [{ b: 2 }]);
    assert.equal(r2.nextOffset, fileSize(f));
    assert.equal(r2.malformed, 0);
  });

  test('a file with only a partial line returns nothing and stays at the offset', () => {
    const f = path.join(dir(), 'p.jsonl');
    fs.writeFileSync(f, '{"a":1');
    assert.deepEqual(readJsonlFrom(f, 0), { records: [], nextOffset: 0, malformed: 0 });
  });

  test('a complete last record without a trailing newline is NOT returned (needs the newline)', () => {
    const f = path.join(dir(), 'p.jsonl');
    fs.writeFileSync(f, '{"a":1}\n{"b":2}');
    const r = readJsonlFrom(f);
    assert.deepEqual(r.records, [{ a: 1 }]);
    assert.equal(r.nextOffset, 8);
  });

  test('malformed complete lines are counted, not thrown, and do not stop the scan', () => {
    const f = path.join(dir(), 'm.jsonl');
    fs.writeFileSync(f, '{"a":1}\nthis is not json\n{"b":2}\n{broken\n');
    const r = readJsonlFrom(f);
    assert.deepEqual(r.records, [{ a: 1 }, { b: 2 }]);
    assert.equal(r.malformed, 2);
    assert.equal(r.nextOffset, fileSize(f));
  });

  test('blank lines and CRLF line endings are skipped / tolerated', () => {
    const f = path.join(dir(), 'c.jsonl');
    fs.writeFileSync(f, '{"a":1}\r\n\r\n   \n{"b":2}\r\n');
    const r = readJsonlFrom(f);
    assert.deepEqual(r.records, [{ a: 1 }, { b: 2 }]);
    assert.equal(r.malformed, 0);
  });

  test('offset beyond file size restarts at 0 (file replaced)', () => {
    const f = path.join(dir(), 'r.jsonl');
    fs.writeFileSync(f, '{"a":1}\n{"b":2}\n');
    const r = readJsonlFrom(f, 100000);
    assert.deepEqual(r.records, [{ a: 1 }, { b: 2 }]);
    assert.equal(r.nextOffset, fileSize(f));
  });

  test('offset beyond file size on a file with no complete line reports offset 0', () => {
    const f = path.join(dir(), 'r.jsonl');
    fs.writeFileSync(f, '{"a"');
    assert.deepEqual(readJsonlFrom(f, 100), { records: [], nextOffset: 0, malformed: 0 });
  });

  test('offset exactly at end of file yields nothing', () => {
    const f = path.join(dir(), 'r.jsonl');
    fs.writeFileSync(f, '{"a":1}\n');
    assert.deepEqual(readJsonlFrom(f, 8), { records: [], nextOffset: 8, malformed: 0 });
  });

  test('offsets are byte offsets, correct across multibyte records', () => {
    const f = path.join(dir(), 'u.jsonl');
    appendJsonl(f, { s: '😀файл' });
    const size1 = fileSize(f);
    appendJsonl(f, { s: 'second' });
    const r1 = readJsonlFrom(f, 0);
    assert.equal(r1.records.length, 2);
    const r2 = readJsonlFrom(f, size1);
    assert.deepEqual(r2.records, [{ s: 'second' }]);
    assert.equal(r2.nextOffset, fileSize(f));
  });

  test('incremental tailing never loses or duplicates records', () => {
    const f = path.join(dir(), 't.jsonl');
    let offset = 0;
    const seen = [];
    for (let i = 0; i < 50; i++) {
      appendJsonl(f, { i });
      if (i % 7 === 0) {
        const r = readJsonlFrom(f, offset);
        seen.push(...r.records);
        offset = r.nextOffset;
      }
    }
    const r = readJsonlFrom(f, offset);
    seen.push(...r.records);
    assert.deepEqual(seen.map((x) => x.i), Array.from({ length: 50 }, (_, i) => i));
  });
});

describe('fsutil: truncateUtf8', () => {
  test('no truncation when it fits (exactly and below)', () => {
    assert.deepEqual(truncateUtf8('hello', 5), { text: 'hello', truncated: false });
    assert.deepEqual(truncateUtf8('hello', 100), { text: 'hello', truncated: false });
    assert.deepEqual(truncateUtf8('', 0), { text: '', truncated: false });
  });

  test('null/undefined become an empty string', () => {
    assert.deepEqual(truncateUtf8(null, 10), { text: '', truncated: false });
    assert.deepEqual(truncateUtf8(undefined, 10), { text: '', truncated: false });
  });

  test('ASCII truncation is exact', () => {
    assert.deepEqual(truncateUtf8('abcdef', 3), { text: 'abc', truncated: true });
    assert.deepEqual(truncateUtf8('abcdef', 0), { text: '', truncated: true });
  });

  test('Cyrillic (2-byte) is not split', () => {
    const s = 'абв'; // 6 bytes
    assert.deepEqual(truncateUtf8(s, 6), { text: s, truncated: false });
    assert.deepEqual(truncateUtf8(s, 5), { text: 'аб', truncated: true });
    assert.deepEqual(truncateUtf8(s, 4), { text: 'аб', truncated: true });
    assert.deepEqual(truncateUtf8(s, 3), { text: 'а', truncated: true });
    assert.deepEqual(truncateUtf8(s, 1), { text: '', truncated: true });
  });

  test('emoji (4-byte) is not split', () => {
    const s = '😀😀'; // 8 bytes
    for (const [max, expected] of [[8, s], [7, '😀'], [5, '😀'], [4, '😀'], [3, ''], [1, ''], [0, '']]) {
      const r = truncateUtf8(s, max);
      assert.equal(r.text, expected, `max=${max}`);
      assert.equal(r.truncated, max < 8);
    }
  });

  test('3-byte (CJK, euro) is not split', () => {
    const s = '€€€'; // 9 bytes
    assert.equal(truncateUtf8(s, 8).text, '€€');
    assert.equal(truncateUtf8(s, 7).text, '€€');
    assert.equal(truncateUtf8(s, 6).text, '€€');
    assert.equal(truncateUtf8(s, 5).text, '€');
  });

  test('every cut point of a mixed string yields valid UTF-8 within the limit', () => {
    const s = 'aф😀b€z🚀б';
    const total = Buffer.byteLength(s);
    for (let max = 0; max <= total + 2; max++) {
      const r = truncateUtf8(s, max);
      assert.ok(Buffer.byteLength(r.text) <= max || max >= total, `max=${max}`);
      assert.ok(!r.text.includes('�'), `max=${max} produced a replacement char`);
      assert.ok(s.startsWith(r.text), `max=${max} not a prefix`);
      assert.equal(r.truncated, max < total);
      // Greedy: one more code point would not have fit.
      if (r.truncated) {
        const next = [...s.slice(r.text.length)][0];
        assert.ok(Buffer.byteLength(r.text) + Buffer.byteLength(next) > max, `max=${max} cut too early`);
      }
    }
  });

  test('negative maxBytes yields an empty string rather than chopping the tail', () => {
    assert.equal(truncateUtf8('abc', -1).text, '');
  });
});

describe('fsutil: withRetry', () => {
  const errWith = (code) => Object.assign(new Error(code), { code });

  test('returns the value of a fn that succeeds first time', () => {
    let calls = 0;
    assert.equal(withRetry(() => { calls++; return 7; }), 7);
    assert.equal(calls, 1);
  });

  test('retries EBUSY twice then succeeds', () => {
    let calls = 0;
    const result = withRetry(() => {
      calls++;
      if (calls <= 2) throw errWith('EBUSY');
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  test('retries EPERM, EACCES and ENOTEMPTY too', () => {
    for (const code of ['EPERM', 'EACCES', 'ENOTEMPTY']) {
      let calls = 0;
      assert.equal(withRetry(() => { calls++; if (calls === 1) throw errWith(code); return code; }), code);
      assert.equal(calls, 2, code);
    }
  });

  test('does not retry ENOENT or other codes', () => {
    for (const code of ['ENOENT', 'EEXIST', 'EISDIR', 'EINVAL']) {
      let calls = 0;
      assert.throws(() => withRetry(() => { calls++; throw errWith(code); }), { code });
      assert.equal(calls, 1, code);
    }
  });

  test('does not retry errors without a code, or thrown non-errors', () => {
    let calls = 0;
    assert.throws(() => withRetry(() => { calls++; throw new Error('plain'); }), /plain/);
    assert.equal(calls, 1);
    calls = 0;
    assert.throws(() => withRetry(() => { calls++; throw null; }));
    assert.equal(calls, 1);
  });

  test('gives up on a persistent EBUSY after bounded retries and rethrows the original error', () => {
    let calls = 0;
    const t0 = Date.now();
    assert.throws(() => withRetry(() => { calls++; throw errWith('EBUSY'); }), { code: 'EBUSY' });
    assert.equal(calls, 10); // first attempt + 9 retries
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 2000 && elapsed < 8000, `elapsed ${elapsed}ms`);
  });
});

describe('fsutil: withMutex', () => {
  test('runs fn, returns its value, removes the lock file', () => {
    const f = path.join(dir(), 'a.mutex');
    assert.equal(withMutex(f, () => { assert.ok(exists(f)); return 'val'; }), 'val');
    assert.equal(exists(f), false);
  });

  test('lock file holds pid metadata while held', () => {
    const f = path.join(dir(), 'a.mutex');
    withMutex(f, () => {
      const meta = readJson(f);
      assert.equal(meta.pid, process.pid);
      assert.match(meta.acquired_at, /^\d{4}-/);
    });
  });

  test('lock file is removed after fn throws, and the error propagates', () => {
    const f = path.join(dir(), 'a.mutex');
    assert.throws(() => withMutex(f, () => { throw new Error('boom'); }), /boom/);
    assert.equal(exists(f), false);
    // and the mutex is usable again immediately
    assert.equal(withMutex(f, () => 1, { timeoutMs: 200 }), 1);
  });

  test('is exclusive: nested acquisition from the same process times out quickly and the outer lock survives', () => {
    const f = path.join(dir(), 'a.mutex');
    withMutex(f, () => {
      const t0 = Date.now();
      assert.throws(() => withMutex(f, () => assert.fail('must not run'), { timeoutMs: 150 }), /Timed out waiting for mutex a\.mutex/);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 100 && elapsed < 2000, `elapsed ${elapsed}ms`);
      assert.ok(exists(f), 'failed waiter must not remove the holder\'s lock');
    });
    assert.equal(exists(f), false);
  });

  test('stale mutex (old mtime) is broken and fn runs', () => {
    const f = path.join(dir(), 'a.mutex');
    fs.writeFileSync(f, '{"pid":999999}');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(f, old, old);
    let ran = false;
    withMutex(f, () => { ran = true; }, { timeoutMs: 500 });
    assert.ok(ran);
    assert.equal(exists(f), false);
  });

  test('staleMs is configurable', () => {
    const f = path.join(dir(), 'a.mutex');
    fs.writeFileSync(f, '{}');
    const old = new Date(Date.now() - 2000);
    fs.utimesSync(f, old, old);
    // default staleMs (30 s): not stale -> times out
    assert.throws(() => withMutex(f, () => {}, { timeoutMs: 100 }), /Timed out/);
    assert.ok(exists(f), 'fresh-enough lock must be left alone');
    // staleMs 1000: stale -> broken
    assert.equal(withMutex(f, () => 'broken', { timeoutMs: 500, staleMs: 1000 }), 'broken');
  });

  test('a fresh foreign lock is not stolen', () => {
    const f = path.join(dir(), 'a.mutex');
    fs.writeFileSync(f, '{"pid":1}');
    assert.throws(() => withMutex(f, () => assert.fail('must not run'), { timeoutMs: 100 }), /Timed out/);
    assert.equal(fs.readFileSync(f, 'utf8'), '{"pid":1}');
  });

  test('missing parent dir is an error, not a hang', () => {
    const f = path.join(dir(), 'nope', 'a.mutex');
    assert.throws(() => withMutex(f, () => {}, { timeoutMs: 100 }), { code: 'ENOENT' });
  });

  test('cross-process: 4 processes doing read-modify-write under the mutex lose no updates', async () => {
    const d = dir();
    const counterFile = path.join(d, 'counter.json');
    const mutexFile = path.join(d, 'counter.mutex');
    fs.writeFileSync(counterFile, '{"n":0}');
    const code = `
      import { withMutex, readJson, writeJsonAtomic } from ${JSON.stringify(FSUTIL_URL)};
      const [counterFile, mutexFile] = process.argv.slice(1);
      for (let i = 0; i < 25; i++) {
        withMutex(mutexFile, () => {
          const v = readJson(counterFile);
          writeJsonAtomic(counterFile, { n: v.n + 1 });
        }, { timeoutMs: 30000 });
      }
    `;
    const results = await Promise.all([1, 2, 3, 4].map(() => runChild(code, [counterFile, mutexFile])));
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    assert.equal(readJson(counterFile).n, 100);
    assert.equal(exists(mutexFile), false);
    assert.deepEqual(tmpFiles(d), []);
  });
});

describe('fsutil: concurrent atomic writes', () => {
  test('writeJsonAtomic from 4 racing processes: readers never see a partial document', async () => {
    const d = dir();
    const target = path.join(d, 'shared.json');
    const PAYLOAD = 60000;
    writeJsonAtomic(target, { writer: -1, seq: -1, len: PAYLOAD, data: 'i'.repeat(PAYLOAD) });

    const code = `
      import { writeJsonAtomic } from ${JSON.stringify(FSUTIL_URL)};
      const args = process.argv.slice(1);
      const target = args[0];
      const writer = Number(args[1]);
      const n = Number(args[2]);
      const len = Number(args[3]);
      for (let seq = 0; seq < n; seq++) {
        writeJsonAtomic(target, { writer, seq, len, data: String(writer).repeat(len) });
      }
    `;
    let pending = 4;
    const children = [0, 1, 2, 3].map((w) => runChild(code, [target, String(w), '120', String(PAYLOAD)])
      .finally(() => { pending--; }));

    let reads = 0;
    const problems = [];
    const t0 = Date.now();
    while (pending > 0 && Date.now() - t0 < 120_000) {
      try {
        const doc = readJson(target);
        reads++;
        if (typeof doc.data !== 'string' || doc.data.length !== doc.len || (doc.writer >= 0 && !/^(\d)\1*$/.test(doc.data))) {
          problems.push(`inconsistent document from writer ${doc.writer} seq ${doc.seq}`);
        }
      } catch (err) {
        problems.push(err.message.slice(0, 200));
      }
      await sleep(25); // polling reader; see the tight-reader todo below for why not faster
    }
    const results = await Promise.all(children);
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(problems.slice(0, 5), []);
    assert.ok(reads >= 5, `reader loop only completed ${reads} reads`);

    const final = readJson(target);
    assert.equal(final.data.length, final.len);
    assert.ok(final.seq >= 0 && [0, 1, 2, 3].includes(final.writer));
    assert.deepEqual(tmpFiles(d), [], 'racing writers left temp files behind');
    assert.deepEqual(fs.readdirSync(d), ['shared.json']);
  });

  test('a single writer survives a reader polling every 10 ms without exhausting the rename retries', async () => {
    const d = dir();
    const target = path.join(d, 'shared.json');
    writeJsonAtomic(target, { seq: -1 });
    const code = `
      import { writeJsonAtomic } from ${JSON.stringify(FSUTIL_URL)};
      const [target] = process.argv.slice(1);
      for (let seq = 0; seq < 120; seq++) writeJsonAtomic(target, { seq, data: 'x'.repeat(60000) });
    `;
    let done = false;
    const child = runChild(code, [target]).finally(() => { done = true; });
    const t0 = Date.now();
    while (!done && Date.now() - t0 < 60_000) {
      readJson(target);
      await sleep(10);
    }
    const r = await child;
    assert.equal(r.code, 0, r.stderr.slice(0, 300));
  });
});
