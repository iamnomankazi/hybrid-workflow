// Outcome determination (docs/ARCHITECTURE.md section 5) and result.json assembly for one attempt.
// decideOutcome is pure; collectEvidence and buildResult only read files and never throw for
// a rollout/report/patch problem: the problem is recorded in the result instead.
import fs from 'node:fs';
import { HYBRID_VERSION, SCHEMAS } from '../constants.mjs';
import { classifyFailure, summarizeEvents, summarizeEventsFile } from '../events.mjs';
import { fileSize, readJson, readText, sha256File, truncateUtf8, writeJsonAtomic } from '../fsutil.mjs';
import { capturePatch } from '../git.mjs';
import { compareObserved, defaultCodexHome, findRolloutFile, readObservedConfig, readObservedIsolation } from '../rollout.mjs';
import { globalInstructionProbes } from '../instructions.mjs';
import { findReparsePoints, validateChanges } from '../scope.mjs';

export const MAX_REPORT_BYTES = 16384;
export const MAX_RESULT_FILES = 500;
const STDERR_TAIL_BYTES = 4096;

// ---------- outcome ----------

// Precedence once no worker process remains. `exit` is the parsed exit.json or null,
// `events` an events summary, `classification` 'quota' | 'auth' | null (see resolveClassification).
export function decideOutcome({
  cancelRequested = false, timedOut = false, exit = null, events, finalMessage = false,
  classification = null, patchFailed = false,
}) {
  const out = (state, reason = null, detail = null, exitSource = exit ? 'host' : 'none') => (
    { state, reason, detail, exit_source: exitSource }
  );
  if (cancelRequested) return out('cancelled', 'cancel_requested');
  if (timedOut) return out('failed', 'timeout', 'hard timeout reached; worker killed');
  if (exit?.spawn_error) return out('failed', 'launch_failed', String(exit.spawn_error));

  let outcome;
  if (!exit) {
    if (!(events.turn_completed && finalMessage)) {
      return out('interrupted', 'worker_lost', 'worker process gone without an exit record');
    }
    outcome = out('completed', null, null, 'unknown');
  } else if (!events.turn_completed && classification === 'quota') {
    outcome = out('paused_quota', null, events.failure_message);
  } else if (!events.turn_completed && classification === 'auth') {
    outcome = out('paused_auth', null, events.failure_message);
  } else if (exit.code === 0 && events.turn_completed && finalMessage) {
    outcome = out('completed');
  } else if (exit.code !== 0) {
    const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
    outcome = out('failed', 'nonzero_exit', `exit ${how}${events.failure_message ? `: ${events.failure_message}` : ''}`);
  } else if (!events.turn_completed) {
    outcome = out('failed', 'no_turn_completed', events.failure_message);
  } else {
    outcome = out('failed', 'missing_final_output', 'turn completed but no final message was written');
  }

  if (outcome.state === 'completed' && patchFailed) {
    return { ...outcome, state: 'failed', reason: 'patch_capture_failed', detail: 'patch capture failed' };
  }
  return outcome;
}

// Events give the classification; failing that, a non-zero exit without a completed turn may
// still have printed the quota/auth message to stderr only.
export function resolveClassification({ events, exit, stderrTail = '' }) {
  if (events.classification) return events.classification;
  if (!events.turn_completed && exit && exit.code !== 0) {
    return classifyFailure(stderrTail.split(/\r?\n/).filter((l) => l.trim()));
  }
  return null;
}

// ---------- worker report ----------

export function parseWorkerReport(text, jobId) {
  if (typeof text !== 'string' || !text.trim()) {
    return { present: false, valid_json: false, job_id_matches: false, report: null, raw: null, truncated: false };
  }
  const { text: raw, truncated } = truncateUtf8(text, MAX_REPORT_BYTES);
  let parsed = null;
  try {
    const value = JSON.parse(text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) parsed = value;
  } catch { /* not JSON */ }
  return {
    present: true,
    valid_json: parsed !== null,
    job_id_matches: parsed !== null && parsed.job_id === jobId,
    // The parsed object of an oversized report would defeat the cap; only `raw` is kept then.
    report: truncated ? null : parsed,
    raw,
    truncated,
  };
}

// ---------- patch ----------

// A symlink the spec explicitly allows is itself a reparse point on disk; that is not a violation.
export function mergeValidation(files, validation, reparse, allowSymlinks) {
  const symlinkPaths = new Set(
    files.filter((f) => f.new_mode === '120000').map((f) => f.path.toLowerCase()),
  );
  const extra = reparse.filter((r) => !(allowSymlinks && symlinkPaths.has(r.path.toLowerCase())));
  const violations = [...validation.violations, ...extra];
  const verdict = violations.length > 0 ? 'violations' : files.length === 0 ? 'empty' : 'clean';
  return { verdict, violations };
}

function emptyPatchBlock(error) {
  return {
    captured: false, file: null, sha256: null, bytes: 0, stats: null, files: [], files_truncated: false,
    verdict: 'capture_failed', violations: [], error,
  };
}

export function capturePatchBlock({ ctx, worktree, baseCommit, ap, attempt, spec }) {
  if (!fs.existsSync(worktree)) return emptyPatchBlock('worktree does not exist');
  let block;
  try {
    const cap = capturePatch(ctx, { worktree, baseCommit, patchFile: ap.patch, tmpDir: ap.dir });
    const validation = validateChanges(cap.files, {
      sandbox: spec.preset_config.sandbox,
      writeScope: spec.write_scope,
      allowProtected: spec.allow_protected,
      allowSymlinks: spec.allow_symlinks,
    });
    const reparse = findReparsePoints(worktree, cap.files.map((f) => f.path));
    const { verdict, violations } = mergeValidation(cap.files, validation, reparse, spec.allow_symlinks);
    block = {
      captured: true,
      file: `attempts/${attempt}/patch.diff`,
      sha256: cap.sha256,
      bytes: cap.bytes,
      stats: cap.stats,
      files: cap.files,
      files_truncated: false,
      verdict,
      violations,
      error: null,
    };
  } catch (err) {
    block = emptyPatchBlock(err.message);
  }
  try {
    writeJsonAtomic(ap.patchMeta, {
      stats: block.stats, files: block.files, verdict: block.verdict, violations: block.violations,
      sha256: block.sha256, bytes: block.bytes, error: block.error,
    });
  } catch (err) {
    block.error ??= `patch.json not written: ${err.message}`;
  }
  if (block.files.length > MAX_RESULT_FILES) {
    return { ...block, files: block.files.slice(0, MAX_RESULT_FILES), files_truncated: true };
  }
  return block;
}

// ---------- observed configuration ----------

// globalInstructions is the launch-time record (launch.json); its text is only used, in memory,
// to detect whether it reached the model. `since` is this attempt's launch time: a resumed
// attempt appends to the original rollout, and only its own turn_context describes it.
export function observedBlock({ codexHome, threadId, requested, globalInstructions = null, since = null }) {
  if (!threadId) return { observed: null, matches: null, mismatches: [], isolation: null };
  const file = findRolloutFile(codexHome ?? defaultCodexHome(process.env), threadId);
  const observed = file ? readObservedConfig(file, { since }) : null;
  const { matches, mismatches } = compareObserved(requested, observed);
  let globalProbes = null;
  if (globalInstructions) {
    globalProbes = globalInstructions.present
      ? globalInstructionProbes(globalInstructions.codex_home, globalInstructions.fingerprint)
      : [];
  }
  const isolation = file ? readObservedIsolation(file, { globalProbes }) : null;
  return {
    observed: observed && {
      model: observed.model,
      effort: observed.effort,
      sandbox_policy: observed.sandbox_policy,
      approval_policy: observed.approval_policy,
      turn_context_at: observed.turn_context_at,
      source: observed.source,
    },
    matches,
    mismatches,
    isolation,
  };
}

// ---------- evidence ----------

function readTail(file, bytes) {
  const size = fileSize(file);
  if (!size) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Reads everything the decision and result need. Never throws.
export function collectEvidence({ run, spec, state, ap, ctx, worktree }) {
  const errors = [];
  const guard = (label, fn, fallback) => {
    try {
      return fn();
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
      return fallback;
    }
  };

  const exit = guard('exit.json', () => readJson(ap.exit, { optional: true }), null);
  const events = guard('events.jsonl', () => summarizeEventsFile(ap.events), summarizeEvents([]));
  const stderrTail = guard('stderr.log', () => readTail(ap.stderr, STDERR_TAIL_BYTES), '');
  const lastMessage = guard('last-message.md', () => readText(ap.lastMessage, { optional: true }), null);
  const report = parseWorkerReport(lastMessage, state.job_id);
  const requested = { ...spec.preset_config, approval_policy: 'never' };
  const threadId = state.codex_session_id ?? events.thread_id;

  const launch = guard('launch.json', () => readJson(ap.launch, { optional: true }), null);
  let observed = { observed: null, matches: null, mismatches: [], isolation: null, error: null };
  try {
    observed = {
      ...observedBlock({
        codexHome: run.config.codex_home, threadId, requested,
        globalInstructions: launch?.global_instructions ?? null, since: launch?.created_at ?? null,
      }),
      error: null,
    };
  } catch (err) {
    observed.error = err.message;
  }

  const patch = capturePatchBlock({
    ctx, worktree, baseCommit: state.base_commit, ap, attempt: state.attempt, spec,
  });
  const classification = resolveClassification({ events, exit, stderrTail });
  return {
    exit, events: { ...events, classification: classification ?? events.classification },
    classification, finalMessage: report.present, report, requested, observed, patch, threadId, errors,
  };
}

// ---------- result.json ----------

// `evidence` is null for results of attempts that never ran (rejected / cancelled while queued).
export function buildResult({
  run, spec, state, outcome, evidence, sweep, endedAt, launch = null, specSha256 = null,
}) {
  const ev = evidence?.events;
  const events = ev ? {
    count: ev.count,
    turn_completed: ev.turn_completed,
    turn_failed: ev.turn_failed,
    failure_message: ev.failure_message,
    errors: ev.errors,
    usage: ev.usage,
    item_types: ev.item_types,
    mcp_tool_calls: ev.mcp_tool_calls,
    classification: ev.classification,
    last_event_at: state.last_event_at,
  } : null;
  const requested = spec ? { ...spec.preset_config, approval_policy: 'never' } : null;
  const observed = evidence?.observed;
  return {
    schema: SCHEMAS.jobResult,
    run_id: state.run_id,
    job_id: state.job_id,
    epoch: state.submitted_epoch,
    attempt: state.attempt,
    state: outcome.state,
    reason: outcome.reason,
    detail: outcome.detail,
    timestamps: { queued_at: state.queued_at, started_at: state.started_at, ended_at: endedAt },
    exit: {
      code: evidence?.exit?.code ?? null,
      signal: evidence?.exit?.signal ?? null,
      source: outcome.exit_source ?? 'none',
    },
    provenance: {
      spec_sha256: specSha256,
      capsule_sha256: spec?.capsule_sha256 ?? null,
      prompt_sha256: state.prompt_sha256,
      base_commit: state.base_commit,
      preset: spec?.preset ?? null,
      requested,
      observed: observed?.observed ?? null,
      observed_matches: observed?.matches ?? null,
      observed_mismatches: observed?.mismatches ?? [],
      observed_error: observed?.error ?? null,
      observed_isolation: observed?.isolation ?? null,
      global_instructions: launch?.global_instructions ?? null,
      codex_session_id: state.codex_session_id,
      codex_version: run.versions?.codex ?? null,
      runner_version: HYBRID_VERSION,
      node_version: process.version,
      codex_exe: launch?.exe ?? null,
      env_names: launch?.env_names ?? [],
      path_entries: launch?.path_entries ?? [],
    },
    events,
    worker_report: evidence?.report ?? null,
    patch: evidence?.patch ?? null,
    orphans: sweep ?? { killed: [], failed: [] },
    ...(evidence?.errors.length ? { finalize_errors: evidence.errors } : {}),
  };
}

export function specSha256(file) {
  try {
    return sha256File(file);
  } catch {
    return null;
  }
}
