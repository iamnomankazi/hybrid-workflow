// Durable file primitives. Every JSON state file is written temp + rename, retrying the
// transient sharing violations Windows produces when antivirus, the indexer or a reader
// briefly holds a handle on the destination.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 300, 500, 750, 1000];
// Renaming over a target that another process is reading fails with EPERM for as long as any
// reader holds it open. Contention comes in short bursts (measured <1 s with a 10 ms poller), so
// rename retries quickly with jitter until a deadline instead of backing off to rare attempts.
const RENAME_DEADLINE_MS = 10_000;

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run fn, retrying on transient Windows file-contention errors (~3 s worst case).
export function withRetry(fn) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (!TRANSIENT.has(err?.code) || i >= RETRY_DELAYS_MS.length) throw err;
      sleepSync(RETRY_DELAYS_MS[i]);
    }
  }
}

export function renameReplacing(from, to) {
  const deadline = Date.now() + RENAME_DEADLINE_MS;
  for (;;) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!TRANSIENT.has(err?.code) || Date.now() > deadline) throw err;
      sleepSync(5 + Math.floor(Math.random() * 20));
    }
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tempName(target) {
  return `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

export function writeFileAtomic(target, data) {
  const tmp = tempName(target);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    renameReplacing(tmp, target);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

export function writeJsonAtomic(target, value) {
  if (value === undefined) throw new TypeError(`Refusing to write undefined to ${target}`);
  writeFileAtomic(target, JSON.stringify(value, null, 2) + '\n');
}

// Write-once: fails with EEXIST if the target exists. Used for immutable inputs (spec, capsule).
export function writeFileExclusive(target, data) {
  const fd = fs.openSync(target, 'wx');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readText(file, { optional = false } = {}) {
  try {
    return withRetry(() => fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (optional && err.code === 'ENOENT') return null;
    throw err;
  }
}

export function readJson(file, { optional = false } = {}) {
  const text = readText(file, { optional });
  if (text === null) return null;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${err.message}`);
  }
}

export function exists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

// Single-writer append of one JSON record per line.
export function appendJsonl(file, record) {
  const line = JSON.stringify(record) + '\n';
  withRetry(() => fs.appendFileSync(file, line));
}

// Read complete JSONL records from a byte offset. A trailing partial line (writer mid-append)
// is left for the next call; malformed complete lines are reported, not thrown.
export function readJsonlFrom(file, offset = 0) {
  let buf;
  try {
    buf = withRetry(() => fs.readFileSync(file));
  } catch (err) {
    if (err.code === 'ENOENT') return { records: [], nextOffset: offset, malformed: 0 };
    throw err;
  }
  if (offset > buf.length) offset = 0; // file was replaced; start over
  const end = buf.lastIndexOf(0x0a);
  if (end < offset) return { records: [], nextOffset: offset, malformed: 0 };
  const records = [];
  let malformed = 0;
  for (const line of buf.subarray(offset, end).toString('utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      malformed++;
    }
  }
  return { records, nextOffset: end + 1, malformed };
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256File(file) {
  return sha256(withRetry(() => fs.readFileSync(file)));
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

export function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

// Truncate a UTF-8 string to at most maxBytes bytes without splitting a code point.
export function truncateUtf8(text, maxBytes) {
  maxBytes = Math.max(0, Math.floor(maxBytes));
  const buf = Buffer.from(text ?? '', 'utf8');
  if (buf.length <= maxBytes) return { text: text ?? '', truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString('utf8'), truncated: true };
}

// Exclusive lock file holding JSON metadata. Returns true if acquired.
// Creating a file whose previous incarnation is still "delete pending" (another process just
// released the lock) fails with EPERM rather than EEXIST, so that is retried as transient.
// The content is written to a temp file first and published with a hard link, which fails with
// EEXIST atomically, so a reader never sees an empty or partial lock.
export function tryCreateLock(file, meta) {
  const tmp = tempName(file);
  writeFileExclusive(tmp, JSON.stringify(meta, null, 2) + '\n');
  try {
    withRetry(() => fs.linkSync(tmp, file));
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    try { withRetry(() => fs.rmSync(tmp, { force: true })); } catch { /* best effort */ }
  }
}

// Short critical section guarded by an exclusive mutex file. A mutex is broken only when it is
// older than staleMs AND its recorded holder pid no longer exists (critical sections take ms).
// Residual risk: two waiters breaking the same abandoned mutex at the same instant.
function holderGone(file) {
  let pid;
  try {
    pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid;
  } catch {
    return true; // unreadable or half-written by a crashed holder
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

export function withMutex(file, fn, { timeoutMs = 10_000, staleMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryCreateLock(file, { pid: process.pid, acquired_at: nowIso() })) break;
    try {
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (age > staleMs && holderGone(file)) {
        fs.rmSync(file, { force: true });
        continue;
      }
    } catch { /* vanished between attempts; retry */ }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for mutex ${path.basename(file)}`);
    sleepSync(25);
  }
  try {
    return fn();
  } finally {
    try { withRetry(() => fs.rmSync(file, { force: true })); } catch { /* stale-broken later */ }
  }
}
