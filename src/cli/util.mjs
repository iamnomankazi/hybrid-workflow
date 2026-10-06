// Helpers shared by the command modules: argument/identity parsing, run loading, job
// snapshots, outcome waiting and small formatters.
import path from 'node:path';
import { EXIT, ACTIVE_STATES, TERMINAL_STATES } from '../constants.mjs';
import { runPaths, jobPaths } from '../paths.mjs';
import { ensureDir, nowIso, randomHex, readJson, sleep, writeJsonAtomic } from '../fsutil.mjs';
import * as store from '../store.mjs';
import { HybridError } from '../store.mjs';
import { ensureRunner } from '../launcher.mjs';

export const usageError = (message) => new HybridError(message, EXIT.usage, 'usage');
export const conflictError = (message) => new HybridError(message, EXIT.conflict, 'conflict');
export const notFoundError = (message) => new HybridError(message, EXIT.notFound, 'not_found');

const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

// '90s', '50m', '2h', '200ms' or bare seconds -> milliseconds.
export function parseDuration(text, name = 'duration') {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(text).trim());
  if (!m) throw usageError(`Invalid ${name}: ${text} (use e.g. 90s, 50m, 2h)`);
  return Math.round(Number(m[1]) * DURATION_UNITS[m[2] ?? 's']);
}

// --session, else HYBRID_SESSION_ID, else CLAUDE_CODE_SESSION_ID, else null.
export function resolveSession(values = {}, env = process.env) {
  return values.session || env.HYBRID_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || null;
}

export function anonSession() {
  return `anon-${randomHex(4)}`;
}

// Resolves the session, generating an anonymous one (with a warning) when none is configured.
export function sessionOrAnon(c) {
  if (c.session) return c.session;
  const session = anonSession();
  c.warnings.push(`no session identity (--session, HYBRID_SESSION_ID); generated ${session}`);
  return session;
}

export function nextJobId(existingIds, skip = 0) {
  let max = 0;
  for (const id of existingIds) {
    const m = /^j(\d{3,})$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `j${String(max + 1 + skip).padStart(3, '0')}`;
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

// Compact age: 45s, 12m, 3h05m.
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function ageSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : now - t;
}

// Session ids become file names.
export function safeFileName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
}

export function parseSeq(text, name) {
  if (!/^\d+$/.test(String(text))) throw usageError(`${name} must be a non-negative integer`);
  return Number(text);
}

export function requirePositionals(c, min, max = min) {
  if (c.positionals.length < min || c.positionals.length > max) {
    throw usageError(`Expected ${min === max ? min : `${min}-${max}`} argument(s), got ${c.positionals.length}`);
  }
}

// ---------- run loading ----------

export function selectRun(c) {
  const runId = store.resolveRunId(c.home, c.values.run);
  return { runId, run: store.loadRun(c.home, runId), rp: runPaths(c.home, runId) };
}

// Epoch-fenced selection for mutating commands.
export function selectOwnedRun(c) {
  const sel = selectRun(c);
  const epoch = store.assertOwner(sel.run, c.values.epoch);
  return { ...sel, epoch };
}

// ---------- jobs ----------

// One entry per job directory. state === null means the submit is still pending.
export function listJobs(home, runId) {
  return store.listJobIds(home, runId).map((id) => ({
    id,
    state: store.readJobState(home, runId, id),
  }));
}

export function pendingRequests(home, runId) {
  return store.listPendingRequests(home, runId);
}

// What the runner still has to do. Used by wait, status and run close.
export function workSummary(home, runId) {
  const jobs = listJobs(home, runId);
  const counts = {};
  let pendingSubmits = 0;
  let queued = 0;
  let active = 0;
  for (const j of jobs) {
    const s = j.state?.state ?? 'pending';
    counts[s] = (counts[s] ?? 0) + 1;
    if (!j.state) pendingSubmits++;
    else if (s === 'queued') queued++;
    else if (ACTIVE_STATES.has(s)) active++;
  }
  const requests = pendingRequests(home, runId).length;
  // Under a quota/auth launch hold, queued jobs wait for an owner decision, not for the runner.
  let hold = null;
  try {
    hold = readJson(runPaths(home, runId).runner, { optional: true })?.hold ?? null;
  } catch { /* runner.json mid-write: treat as no hold */ }
  const launchable = hold ? 0 : queued;
  return {
    jobs, counts, queued, active, pendingSubmits, requests, hold,
    busy: launchable + active + pendingSubmits + requests > 0,
    nonTerminal: jobs.filter((j) => !j.state || !TERMINAL_STATES.has(j.state.state)).map((j) => j.id),
  };
}

export function requireJob(home, runId, jobId) {
  store.assertJobId(jobId);
  if (!store.jobExists(home, runId, jobId)) throw notFoundError(`Job not found: ${jobId} in run ${runId}`);
  return { jp: jobPaths(home, runId, jobId), state: store.readJobState(home, runId, jobId) };
}

// ---------- runner / request outcomes ----------

export async function startRunner(home, runId, what) {
  try {
    return await ensureRunner(home, runId);
  } catch (err) {
    if (!(err instanceof HybridError)) throw err;
    throw new HybridError(
      `${what}, but the runner did not start: ${err.message} (retry: hybrid run ensure-runner --epoch <n>)`,
      err.exitCode, err.code,
    );
  }
}

// Polls inbox/done for the request outcome; null if the runner has not processed it in time.
export async function awaitOutcome(home, runId, requestId, { timeoutMs = 20_000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const done = store.readRequestOutcome(home, runId, requestId);
    if (done) return done;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

// Renders a request outcome. A rejected stale_epoch is a fence violation (3), any other rejection an error (1).
export function outcomeResult(label, request, outcome) {
  const status = outcome ? outcome.outcome : 'pending';
  const reason = outcome?.reason ?? null;
  let exitCode = EXIT.ok;
  if (outcome?.outcome === 'rejected') exitCode = reason === 'stale_epoch' ? EXIT.fenced : EXIT.error;
  const text = `${label}: ${status}${reason ? ` (${reason})` : ''}${outcome ? '' : ' (runner has not processed it yet)'}`;
  return {
    data: { request_id: request.id, type: request.type, job_id: request.job_id, outcome: status, reason },
    text,
    exitCode,
  };
}

// ---------- per-session change cursors ----------

const cursorFile = (rp, session) => path.join(rp.cursors, `${safeFileName(session)}.json`);

export function readCursor(rp, session) {
  if (!session) return null;
  const doc = readJson(cursorFile(rp, session), { optional: true });
  return Number.isInteger(doc?.seq) ? doc.seq : null;
}

export function writeCursor(rp, session, seq) {
  ensureDir(rp.cursors);
  writeJsonAtomic(cursorFile(rp, session), { seq, updated_at: nowIso() });
}
