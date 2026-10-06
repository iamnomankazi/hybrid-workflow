// Run store: the file protocol shared by the CLI (control side) and the runner (execution side).
//
// Single-writer rules (see docs/ARCHITECTURE.md):
//   run.json, decision.json, cursors/*, spec.json, capsule.md, inbox/*.json  -> CLI
//   runner.json, runner.lock, state.json, result.json, transitions.jsonl,
//   inbox/done/*, attempts/<n>/{launch.json,prompt.md,patch.*}               -> runner
//   attempts/<n>/{host.json,exit.json}                                        -> job host
//   plan.md                                                                   -> Opus only
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, RUN_ID_RE, JOB_ID_RE, SCHEMAS, REQUEST_TYPES } from './constants.mjs';
import { homePaths, runPaths, jobPaths } from './paths.mjs';
import {
  ensureDir, nowIso, randomHex, readJson, writeJsonAtomic, appendJsonl, readJsonlFrom,
  withRetry, exists,
} from './fsutil.mjs';

export class HybridError extends Error {
  constructor(message, exitCode = EXIT.error, code = 'error') {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
  }
}

export class FencedError extends HybridError {
  constructor(message) {
    super(message, EXIT.fenced, 'fenced');
  }
}

export function generateRunId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const ymd = `${String(date.getFullYear()).slice(2)}${p(date.getMonth() + 1)}${p(date.getDate())}`;
  const hms = `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `r${ymd}-${hms}-${randomHex(2)}`;
}

export function assertRunId(runId) {
  if (!RUN_ID_RE.test(runId ?? '')) throw new HybridError(`Invalid run id: ${runId}`, EXIT.usage, 'usage');
}

export function assertJobId(jobId) {
  if (!JOB_ID_RE.test(jobId ?? '')) throw new HybridError(`Invalid job id: ${jobId}`, EXIT.usage, 'usage');
}

// ---------- global active-run lock ----------

export function readActiveRunLock(home) {
  return readJson(homePaths(home).activeRunLock, { optional: true });
}

// Resolve an explicit --run or fall back to the machine's active run.
export function resolveRunId(home, explicit) {
  if (explicit) {
    assertRunId(explicit);
    return explicit;
  }
  const lock = readActiveRunLock(home);
  if (!lock?.run_id) throw new HybridError('No active run (pass --run <id>)', EXIT.notFound, 'not_found');
  assertRunId(lock.run_id);
  return lock.run_id;
}

// ---------- run.json ----------

export function loadRun(home, runId) {
  assertRunId(runId);
  const run = readJson(runPaths(home, runId).run, { optional: true });
  if (!run) throw new HybridError(`Run not found: ${runId}`, EXIT.notFound, 'not_found');
  if (run.schema !== SCHEMAS.run) {
    throw new HybridError(`Run ${runId} has unsupported schema ${run.schema}`, EXIT.error, 'schema');
  }
  return run;
}

// Ownership fence for mutating commands. Epoch must be an integer equal to the current epoch.
export function assertOwner(run, epoch) {
  const n = typeof epoch === 'string' && /^\d+$/.test(epoch) ? Number(epoch) : epoch;
  if (!Number.isInteger(n)) {
    throw new HybridError('This command mutates the run and requires --epoch <n>', EXIT.usage, 'usage');
  }
  if (run.status !== 'open') throw new HybridError(`Run ${run.run_id} is ${run.status}`, EXIT.conflict, 'conflict');
  if (n !== run.owner.epoch) {
    throw new FencedError(
      `Stale ownership: epoch ${n} != current epoch ${run.owner.epoch} (owner session ${run.owner.session_id}). ` +
        'Re-read state with `hybrid status`; take over explicitly with `hybrid takeover` only if intended.',
    );
  }
  return n;
}

// ---------- inbox (CLI -> runner requests) ----------

// Within one process ids are strictly ordered; across processes, order within a millisecond is
// arbitrary (concurrent requests have no meaningful order anyway).
let requestCounter = 0;

export function writeRequest(home, runId, { type, epoch, session_id, job_id = null, payload = {} }) {
  assertRunId(runId);
  if (job_id !== null) assertJobId(job_id);
  if (!REQUEST_TYPES.includes(type)) throw new Error(`Unknown request type ${type}`);
  const rp = runPaths(home, runId);
  ensureDir(rp.inboxTmp);
  requestCounter = (requestCounter + 1) % 1_000_000;
  const id = `${Date.now().toString().padStart(14, '0')}-${String(requestCounter).padStart(6, '0')}-${randomHex(4)}`;
  const request = {
    schema: SCHEMAS.request, id, type, run_id: runId, epoch, session_id, job_id, payload, created_at: nowIso(),
  };
  // Temp file lives in inbox/.tmp so the runner never sees a partial request.
  const tmp = path.join(rp.inboxTmp, `${id}.json`);
  fs.writeFileSync(tmp, JSON.stringify(request, null, 2) + '\n');
  withRetry(() => fs.renameSync(tmp, path.join(rp.inbox, `${id}.json`)));
  return request;
}

export function listPendingRequests(home, runId) {
  const rp = runPaths(home, runId);
  let entries;
  try {
    entries = fs.readdirSync(rp.inbox, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((d) => d.isFile() && d.name.endsWith('.json')).map((d) => d.name).sort()
    .map((name) => path.join(rp.inbox, name));
}

// Runner: record the outcome in inbox/done and remove the pending request.
export function completeRequest(home, runId, requestFile, request, outcome, reason = null, extra = {}) {
  const rp = runPaths(home, runId);
  ensureDir(rp.inboxDone);
  const name = path.basename(requestFile);
  writeJsonAtomic(path.join(rp.inboxDone, name), {
    ...request, processed_at: nowIso(), outcome, reason, ...extra,
  });
  withRetry(() => fs.rmSync(requestFile, { force: true }));
}

export function readRequestOutcome(home, runId, requestId) {
  return readJson(path.join(runPaths(home, runId).inboxDone, `${requestId}.json`), { optional: true });
}

// ---------- jobs ----------

export function listJobIds(home, runId) {
  try {
    return fs.readdirSync(runPaths(home, runId).jobs, { withFileTypes: true })
      .filter((d) => d.isDirectory() && JOB_ID_RE.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export function readJobSpec(home, runId, jobId) {
  return readJson(jobPaths(home, runId, jobId).spec, { optional: true });
}

export function readJobState(home, runId, jobId) {
  return readJson(jobPaths(home, runId, jobId).state, { optional: true });
}

export function readJobResult(home, runId, jobId) {
  return readJson(jobPaths(home, runId, jobId).result, { optional: true });
}

export function readDecision(home, runId, jobId) {
  return readJson(jobPaths(home, runId, jobId).decision, { optional: true });
}

export function jobExists(home, runId, jobId) {
  return exists(jobPaths(home, runId, jobId).dir);
}

// ---------- transitions feed (runner-owned, append-only) ----------

export function appendTransition(home, runId, record) {
  appendJsonl(runPaths(home, runId).transitions, record);
}

export function readTransitions(home, runId, { sinceSeq = 0, offset = 0 } = {}) {
  const { records, nextOffset } = readJsonlFrom(runPaths(home, runId).transitions, offset);
  return { records: records.filter((r) => Number.isInteger(r.seq) && r.seq > sinceSeq), nextOffset };
}

export function lastTransitionSeq(home, runId) {
  const { records } = readJsonlFrom(runPaths(home, runId).transitions, 0);
  return records.reduce((max, r) => (Number.isInteger(r.seq) && r.seq > max ? r.seq : max), 0);
}

// ---------- runner.json ----------

export function readRunnerStatus(home, runId) {
  return readJson(runPaths(home, runId).runner, { optional: true });
}
