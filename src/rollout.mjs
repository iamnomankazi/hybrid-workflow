// Locating a Codex session rollout and reading the configuration Codex actually applied.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const THREAD_ID_RE = /^[0-9a-f-]{36}$/i;
const MAX_READ_BYTES = 4 * 1024 * 1024;
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

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES);
    const n = fs.readSync(fd, buf, 0, MAX_READ_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Returns only configuration fields; instruction text in the rollout is never surfaced.
export function readObservedConfig(file) {
  let head;
  try {
    head = readHead(file);
  } catch {
    return null;
  }
  let meta = null;
  let ctx = null;
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // includes a line cut off by the read limit
    }
    if (!meta && rec?.type === 'session_meta') meta = rec.payload ?? {};
    else if (!ctx && rec?.type === 'turn_context') ctx = rec.payload ?? {};
    if (meta && ctx) break;
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
    source: 'rollout',
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
