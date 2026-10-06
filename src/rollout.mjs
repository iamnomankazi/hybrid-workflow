// Locating a Codex session rollout and reading the configuration Codex actually applied.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const THREAD_ID_RE = /^[0-9a-f-]{36}$/i;
const MAX_FULL_READ_BYTES = 64 * 1024 * 1024;
const HEAD_READ_BYTES = 8 * 1024 * 1024;
const MAX_WALK_ENTRIES = 20000;

export function defaultCodexHome(env = process.env) {
  return path.join(env.USERPROFILE || os.homedir(), '.codex');
}

const pad = (n) => String(n).padStart(2, '0');

function dateDirs(around) {
  const dirs = new Set();
  for (let d = -1; d <= 1; d++) {
    const t = new Date(around.getTime() + d * 86_400_000);
    dirs.add(`${t.getUTCFullYear()}/${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}`);
    dirs.add(`${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())}`);
  }
  return [...dirs];
}

export function findRolloutFile(codexHome, threadId, { around = new Date() } = {}) {
  if (typeof threadId !== 'string' || !THREAD_ID_RE.test(threadId)) return null;
  const suffix = `-${threadId}.jsonl`.toLowerCase();
  const matches = (name) => name.toLowerCase().endsWith(suffix) && name.startsWith('rollout-');
  const sessions = path.join(codexHome, 'sessions');

  for (const rel of dateDirs(around)) {
    const dir = path.join(sessions, ...rel.split('/'));
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names.find(matches);
    if (hit) return path.join(dir, hit);
  }

  // Fallback for clock skew or a session that ran across more than a day.
  const stack = [sessions];
  let budget = MAX_WALK_ENTRIES;
  while (stack.length && budget > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (--budget < 0) break;
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (matches(entry.name)) return path.join(dir, entry.name);
    }
  }
  return null;
}

// Whole rollout up to MAX_FULL_READ_BYTES; beyond that the head (session start, where the
// instruction messages live) plus the tail (where the latest attempt's records live). A line cut
// at the seam is unparsable and skipped.
function readRollout(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const read = (len, pos) => {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      return buf.subarray(0, n).toString('utf8');
    };
    if (size <= MAX_FULL_READ_BYTES) return read(size, 0);
    const tail = MAX_FULL_READ_BYTES - HEAD_READ_BYTES;
    return `${read(HEAD_READ_BYTES, 0)}\n${read(tail, size - tail)}`;
  } finally {
    fs.closeSync(fd);
  }
}

function* records(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch { /* cut line */ }
  }
}

// Returns only configuration fields; instruction text in the rollout is never surfaced.
// `codex exec resume` appends each attempt's turn_context to the SAME rollout, so the record
// describing an attempt is the last turn_context written at or after that attempt's launch
// (`since`). Without `since`, the last turn_context in the file.
export function readObservedConfig(file, { since = null } = {}) {
  let text;
  try {
    text = readRollout(file);
  } catch {
    return null;
  }
  const parsed = since ? Date.parse(since) : NaN;
  const sinceMs = Number.isNaN(parsed) ? null : parsed;
  let meta = null;
  let ctx = null;
  let ctxAt = null;
  let inWindow = 0;
  for (const rec of records(text)) {
    if (!meta && rec?.type === 'session_meta') meta = rec.payload ?? {};
    else if (rec?.type === 'turn_context') {
      const at = Date.parse(rec.timestamp ?? '');
      if (sinceMs !== null && !(at >= sinceMs)) continue;
      ctx = rec.payload ?? {};
      ctxAt = rec.timestamp ?? null;
      inWindow++;
    }
  }
  if (!meta) return null;
  const sandbox = ctx?.sandbox_policy;
  return {
    session_id: meta.session_id ?? meta.id ?? null,
    cli_version: meta.cli_version ?? null,
    cwd: meta.cwd ?? null,
    model: ctx?.model ?? null,
    effort: ctx?.effort ?? null,
    approval_policy: ctx?.approval_policy ?? null,
    sandbox_policy: (typeof sandbox === 'string' ? sandbox : sandbox?.type) ?? null,
    turn_context_at: ctxAt,
    turn_contexts_in_window: inWindow,
    source: 'rollout',
  };
}

// What reached the model besides the task: Codex's skills catalog block, and (when probes for
// the pinned global instructions file are available) that file's text. Presence only. The
// whole session counts: instruction messages are recorded once at session start but remain in
// the model's context for every resumed attempt.
export function readObservedIsolation(file, { globalProbes = null } = {}) {
  let text;
  try {
    text = readRollout(file);
  } catch {
    return null;
  }
  return {
    skills_catalog_present: text.includes('<skills_instructions>'),
    global_instructions_present: globalProbes === null
      ? null
      : globalProbes.length > 0 && globalProbes.some((probe) => text.includes(JSON.stringify(probe).slice(1, -1))),
  };
}

export function compareObserved(requested, observed) {
  if (!observed) return { matches: null, mismatches: [] };
  const pairs = [
    ['model', requested.model, observed.model],
    ['effort', requested.effort, observed.effort],
    ['sandbox', requested.sandbox, observed.sandbox_policy],
    ['approval_policy', requested.approval_policy, observed.approval_policy],
  ];
  const mismatches = pairs
    .filter(([, want, got]) => want !== got)
    .map(([field, want, got]) => ({ field, requested: want, observed: got }));
  return { matches: mismatches.length === 0, mismatches };
}
