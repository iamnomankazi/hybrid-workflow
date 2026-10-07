import { TERMINAL_STATES } from '../../constants.mjs';
import * as store from '../../store.mjs';
import { runnerAlive } from '../../launcher.mjs';
import { runPaths } from '../../paths.mjs';
import { controllerAttached, readController } from '../../controller.mjs';
import {
  ageSince, fmtDuration, parseSeq, readCursor, requireJob, requirePositionals, selectRun, usageError, workSummary, writeCursor,
} from '../util.mjs';

function elapsedMs(state, spec, now) {
  if (!state) return spec ? ageSince(spec.submitted_at, now) : null;
  if (TERMINAL_STATES.has(state.state)) {
    const start = Date.parse(state.started_at);
    const end = Date.parse(state.ended_at);
    return Number.isNaN(start) || Number.isNaN(end) ? null : end - start;
  }
  return ageSince(state.started_at ?? state.queued_at, now);
}

function patchSummary(result) {
  const p = result?.patch;
  if (!p) return null;
  return { verdict: p.verdict, files: p.stats?.files ?? 0, added: p.stats?.added ?? 0, deleted: p.stats?.deleted ?? 0 };
}

function jobSummary(home, runId, { id, state }, now) {
  const spec = store.readJobSpec(home, runId, id);
  const decision = store.readDecision(home, runId, id);
  const result = state && TERMINAL_STATES.has(state.state) ? store.readJobResult(home, runId, id) : null;
  return {
    job_id: id,
    state: state?.state ?? 'pending',
    reason: state?.reason ?? null,
    attempt: state?.attempt ?? null,
    preset: spec?.preset ?? null,
    elapsed_ms: elapsedMs(state, spec, now),
    decision: decision?.decision ?? null,
    patch: patchSummary(result),
  };
}

function jobLine(j) {
  const parts = [
    j.job_id,
    j.reason ? `${j.state}(${j.reason})` : j.state,
    `a${j.attempt ?? '-'}`,
    j.preset ?? '-',
    fmtDuration(j.elapsed_ms),
  ];
  if (j.decision) parts.push(`decision=${j.decision}`);
  if (j.patch) parts.push(`patch=${j.patch.verdict} ${j.patch.files}f +${j.patch.added}/-${j.patch.deleted}`);
  return parts.join(' ');
}

function runnerSummary(live, now) {
  const { alive, lock, runner } = live;
  const hb = runner?.heartbeat_at ? ageSince(runner.heartbeat_at, now) : null;
  return {
    alive,
    pid: alive ? lock.pid : null,
    status: runner?.status ?? null,
    heartbeat_age_s: hb === null ? null : Math.round(hb / 1000),
    hold: runner?.hold ?? null,
  };
}

// The last temporary controller (hybrid controller start), if any.
function controllerSummary(file, now) {
  const rec = readController(file);
  if (!rec) return null;
  return {
    session_id: rec.session_id, status: rec.status, attached: controllerAttached(rec, now),
    start_epoch: rec.start_epoch, host_pid: rec.host?.pid ?? null, thread_id: rec.thread_id,
    started_at: rec.started_at, ended_at: rec.ended_at, stop_reason: rec.stop_reason, dir: rec.dir,
  };
}

function controllerText(k) {
  if (k.attached) return `${k.session_id} running (host pid ${k.host_pid}, launched at epoch ${k.start_epoch})`;
  const end = k.status === 'running' ? 'not responding' : `${k.status}${k.stop_reason ? ` (${k.stop_reason})` : ''}`;
  return `${k.session_id} ${end}${k.ended_at ? ` at ${k.ended_at}` : ''}`;
}

function runnerText(r) {
  if (!r.alive) return `not running${r.status ? ` (last status ${r.status})` : ''}`;
  const hold = r.hold ? ` hold=${r.hold.reason}` : '';
  return `alive pid ${r.pid} heartbeat ${r.heartbeat_age_s === null ? '-' : `${r.heartbeat_age_s}s`}${hold}`;
}

async function runSummary(c, runId, run) {
  const now = Date.now();
  const work = workSummary(c.home, runId);
  const runner = runnerSummary(await runnerAlive(c.home, runId), now);
  const controller = controllerSummary(runPaths(c.home, runId).controller, now);
  const jobs = work.jobs.map((j) => jobSummary(c.home, runId, j, now));
  const text = [
    `run: ${runId} ${run.status}`,
    `owner: ${run.owner.session_id} epoch ${run.owner.epoch}`,
    `base: ${run.base_commit.slice(0, 12)}`,
    `repo: ${run.repo.alias}`,
    `runner: ${runnerText(runner)}`,
    ...(controller ? [`controller: ${controllerText(controller)}`] : []),
    `counts: ${Object.entries(work.counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`,
    ...jobs.map(jobLine),
  ].join('\n');
  return {
    data: {
      run_id: runId, status: run.status, owner: run.owner, base_commit: run.base_commit, repo: run.repo.alias,
      runner, controller, counts: work.counts, jobs,
    },
    text,
  };
}

function changeLine(r) {
  const target = r.kind === 'job' ? r.job_id : r.kind;
  const move = r.kind === 'job' ? `${r.from ?? '(new)'}->${r.to}` : `-> ${r.to}`;
  return `${r.seq} ${target} ${move}${r.reason ? ` (${r.reason})` : ''}`;
}

export function formatChanges(records) {
  return records.map(changeLine);
}

async function changedView(c, runId, run, rp) {
  const explicit = c.values.since !== undefined;
  const since = explicit ? parseSeq(c.values.since, '--since') : (readCursor(rp, c.session) ?? 0);
  const { records } = store.readTransitions(c.home, runId, { sinceSeq: since });
  const cursor = records.reduce((max, r) => Math.max(max, r.seq), since);
  if (c.session && !explicit) writeCursor(rp, c.session, cursor);
  const summary = await runSummary(c, runId, run);
  return {
    data: { cursor, changes: records, run: summary.data },
    text: [...formatChanges(records), `cursor: ${cursor}`, summary.text].join('\n'),
  };
}

function jobView(c, runId, jobId) {
  const { jp, state } = requireJob(c.home, runId, jobId);
  const now = Date.now();
  const summary = jobSummary(c.home, runId, { id: jobId, state }, now);
  const result = state && TERMINAL_STATES.has(state.state) ? store.readJobResult(c.home, runId, jobId) : null;
  const report = result?.worker_report?.report ?? null;
  const data = {
    ...summary,
    detail: state?.detail ?? null,
    mode: state?.mode ?? null,
    worktree: state?.worktree ?? null,
    codex_session_id: state?.codex_session_id ?? null,
    cancel_requested: state?.cancel_requested ?? false,
    created_at: state?.created_at ?? null,
    queued_at: state?.queued_at ?? null,
    started_at: state?.started_at ?? null,
    ended_at: state?.ended_at ?? null,
    last_event_at: state?.last_event_at ?? null,
    worker_status: report?.status ?? null,
    worker_summary: report?.summary ?? null,
    job_dir: jp.dir,
  };
  const lines = [jobLine(summary)];
  if (data.detail) lines.push(`detail: ${data.detail}`);
  if (data.codex_session_id) lines.push(`codex_session: ${data.codex_session_id}`);
  if (data.last_event_at) lines.push(`last_event: ${data.last_event_at} (${fmtDuration(ageSince(data.last_event_at, now))} ago)`);
  if (data.worktree) lines.push(`worktree: ${data.worktree}`);
  if (data.worker_status) lines.push(`worker: ${data.worker_status} - ${data.worker_summary ?? ''}`);
  if (result) lines.push(`(hybrid result ${jobId} for the full outcome)`);
  return { data, text: lines.join('\n') };
}

export const status = {
  usage: 'status [<job>] [--changed [--since <n>]]',
  options: { changed: { type: 'boolean' }, since: { type: 'string' } },
  async run(c) {
    requirePositionals(c, 0, 1);
    const { runId, run, rp } = selectRun(c);
    if (c.values.since !== undefined && !c.values.changed) throw usageError('--since needs --changed');
    if (c.positionals.length) return jobView(c, runId, c.positionals[0]);
    if (c.values.changed) return changedView(c, runId, run, rp);
    return runSummary(c, runId, run);
  },
};
