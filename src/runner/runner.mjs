// The per-run runner: inbox, launch, monitor, reconcile, finalize. docs/RUNNER.md is the algorithm.
// One sequential loop (never overlapping ticks); every state change goes through transition().
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ACTIVE_STATES, HYBRID_VERSION, JOB_ID_RE, RESUMABLE_STATES, SCHEMAS, TERMINAL_STATES, assertTransition,
} from '../constants.mjs';
import {
  appendTransition, completeRequest, lastTransitionSeq, listJobIds, listPendingRequests, loadRun,
  readJobSpec, readJobState,
} from '../store.mjs';
import { attemptPaths, homePaths, jobPaths, runPaths, worktreePath, JOB_HOST_ENTRY, WORKER_OUTPUT_SCHEMA } from '../paths.mjs';
import {
  ensureDir, exists, fileSize, nowIso, readJson, readJsonlFrom, readText, sha256, sha256File, sleep,
  tryCreateLock, withRetry, writeFileExclusive, writeJsonAtomic,
} from '../fsutil.mjs';
import { buildExecArgs, buildResumeArgs, buildWorkerEnv } from '../codex.mjs';
import { composePrompt, composeResumePrompt } from '../spec.mjs';
import * as git from '../git.mjs';
import { areAlive, getIdentity, isAlive, killTree, ownIdentity, sweepOrphans } from '../proc.mjs';
import { buildResult, collectEvidence, decideOutcome, specSha256 } from './finalize.mjs';
import { defaultCodexHome } from '../rollout.mjs';
import { describeGlobalInstructions, readGlobalInstructions } from '../instructions.mjs';

const LAUNCH_WAIT_MS = 20_000;
const RECONCILE_LAUNCH_WAIT_MS = 10_000;
const EVENT_PERSIST_MS = 30_000;
const RE_KILL_MS = 5_000;
const MAX_FINALIZE_FAILURES = 3;

const iso = (ms) => new Date(ms).toISOString();
const parseMs = (value) => (value ? Date.parse(value) : null);

function readOptionalJson(file) {
  try {
    return readJson(file, { optional: true });
  } catch {
    return null; // a partial or corrupt document is treated as absent; the next poll sees it whole
  }
}

export class Runner {
  constructor({ home, runId }) {
    this.home = home;
    this.runId = runId;
    this.rp = runPaths(home, runId);
    this.jobs = new Map();
    this.seq = 0;
    this.hold = null;
    this.status = 'starting';
    this.startedAt = nowIso();
    this.identity = null;
    this.lockHeld = false;
    this.exitReason = null;
    this.idleSinceMs = null;
    this.lastHeartbeatMs = 0;
  }

  // ---------- logging ----------

  log(message) {
    try {
      fs.appendFileSync(this.rp.runnerLog, `${nowIso()} ${message}\n`);
    } catch { /* logging must never take the runner down */ }
  }

  progress(message) {
    try {
      fs.appendFileSync(this.rp.progress, `${nowIso()} ${message}\n`);
    } catch { /* best effort */ }
  }

  // ---------- startup ----------

  // Returns false when this process should simply exit 0 (closed run, or another runner owns it).
  async start() {
    this.run = loadRun(this.home, this.runId);
    this.mm = this.run.config.minute_ms ?? 60_000;
    if (this.run.status !== 'open') {
      this.log(`run is ${this.run.status}; exiting`);
      return false;
    }
    ensureDir(this.rp.inboxDone);
    this.identity = await ownIdentity();
    if (!(await this.acquireLock())) return false;
    this.ctx = { gitExe: this.run.tools.git_exe, hooksDir: git.ensureEmptyHooksDir(homePaths(this.home).emptyHooks) };

    this.hold = readOptionalJson(this.rp.runner)?.hold ?? null;
    this.loadJobs();
    this.repairFeed();
    this.seq = Math.max(lastTransitionSeq(this.home, this.runId), ...[...this.jobs.values()].map((j) => j.state.seq ?? 0));

    this.writeRunnerJson('starting');
    await this.reconcile();
    this.status = 'running';
    this.writeRunnerJson('running');
    this.log(`runner started (pid ${process.pid}, seq ${this.seq}, ${this.jobs.size} job(s))`);
    return true;
  }

  async acquireLock() {
    const meta = {
      pid: this.identity.pid, start_time: this.identity.start_time, version: HYBRID_VERSION, acquired_at: nowIso(),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (tryCreateLock(this.rp.runnerLock, meta)) {
        this.lockHeld = true;
        return true;
      }
      const holder = await this.readLockHolder();
      if (!holder) {
        this.log('runner.lock exists but is unreadable; not breaking it');
        return false;
      }
      if (await isAlive(holder)) {
        this.log(`runner.lock held by live runner pid ${holder.pid}; exiting`);
        return false;
      }
      this.log(`removing stale runner.lock (pid ${holder.pid})`);
      withRetry(() => fs.rmSync(this.rp.runnerLock, { force: true }));
    }
    this.log('lost the race for runner.lock; exiting');
    return false;
  }

  // A lock being written by a runner that just created it can be briefly empty: retry before giving up.
  async readLockHolder() {
    for (let i = 0; i < 4; i++) {
      const lock = readOptionalJson(this.rp.runnerLock);
      if (lock && Number.isInteger(lock.pid) && lock.start_time) return { pid: lock.pid, start_time: lock.start_time };
      await sleep(250);
    }
    return null;
  }

  releaseLock() {
    if (!this.lockHeld) return;
    const lock = readOptionalJson(this.rp.runnerLock);
    if (lock?.pid === this.identity.pid && lock?.start_time === this.identity.start_time) {
      try {
        withRetry(() => fs.rmSync(this.rp.runnerLock, { force: true }));
      } catch (err) {
        this.log(`could not release runner.lock: ${err.message}`);
      }
    }
    this.lockHeld = false;
  }

  loadJobs() {
    for (const jobId of listJobIds(this.home, this.runId)) {
      try {
        const state = readJobState(this.home, this.runId, jobId);
        if (state) this.jobs.set(jobId, this.makeJob(state));
      } catch (err) {
        this.log(`job ${jobId}: unreadable state.json (${err.message}); ignored`);
      }
    }
  }

  makeJob(state) {
    return {
      id: state.job_id,
      state,
      spec: null,
      mon: {
        eventsSeen: state.events_bytes ?? 0,
        lastEventMs: parseMs(state.last_event_at),
        lastPersistMs: 0,
        nextLivenessMs: 0,
        lastKillMs: 0,
        launchDeadlineMs: null,
        launchedHere: false,
        finalizeFailures: 0,
      },
    };
  }

  // A crash between state.json and the feed append leaves state.seq ahead of the feed.
  repairFeed() {
    const feedMax = lastTransitionSeq(this.home, this.runId);
    const ahead = [...this.jobs.values()].map((j) => j.state).filter((s) => (s.seq ?? 0) > feedMax)
      .sort((a, b) => a.seq - b.seq);
    for (const s of ahead) {
      appendTransition(this.home, this.runId, {
        seq: s.seq, ts: s.updated_at, kind: 'job', job_id: s.job_id, from: null, to: s.state,
        reason: 'recovered_feed', attempt: s.attempt,
      });
      this.log(`feed repaired: job ${s.job_id} seq ${s.seq} (${s.state})`);
    }
  }

  // ---------- reconcile (ARCHITECTURE section 11) ----------

  async reconcile() {
    for (const job of this.jobs.values()) {
      const s = job.state;
      if (!ACTIVE_STATES.has(s.state)) continue;
      try {
        if (s.state === 'launching') {
          // The host may still be coming up; the monitor waits a bounded time for host.json.
          job.mon.launchDeadlineMs = Date.now() + RECONCILE_LAUNCH_WAIT_MS;
        } else if (s.cancel_requested || s.timed_out) {
          await this.killJob(job); // the previous runner may have died between the flag and the kill
        }
        this.log(`reconcile: job ${job.id} is ${s.state}`);
      } catch (err) {
        this.log(`reconcile: job ${job.id}: ${err.message}`);
      }
    }
  }

  // ---------- loop ----------

  async loop() {
    const pollMs = this.run.config.poll_ms;
    while (!this.exitReason) {
      try {
        await this.tick();
      } catch (err) {
        this.log(`tick failed: ${err.stack ?? err.message}`);
      }
      if (!this.exitReason) await sleep(pollMs);
    }
    this.status = 'exited';
    this.writeRunnerJson('exited', this.exitReason);
    this.releaseLock();
    this.log(`runner exiting: ${this.exitReason}`);
  }

  async tick() {
    await this.processInbox();
    await this.monitorJobs();
    await this.launchQueued();
    this.heartbeat();
    this.checkIdle();
  }

  requestStop(reason) {
    this.exitReason ??= reason;
  }

  // Uncaught-error path: workers keep running and the next runner adopts them.
  crash(err) {
    this.log(`CRASH: ${err?.stack ?? err}`);
    if (!this.lockHeld) return;
    try {
      this.status = 'crashed';
      this.writeRunnerJson('crashed', String(err?.message ?? err).slice(0, 500));
    } catch { /* already logged */ }
    this.releaseLock();
  }

  // ---------- runner.json / heartbeat / idle ----------

  counts() {
    const c = { queued: 0, active: 0, terminal: 0 };
    for (const { state } of this.jobs.values()) {
      if (state.state === 'queued') c.queued++;
      else if (ACTIVE_STATES.has(state.state)) c.active++;
      else if (TERMINAL_STATES.has(state.state)) c.terminal++;
    }
    return c;
  }

  writeRunnerJson(status, exitReason = null) {
    this.lastHeartbeatMs = Date.now();
    writeJsonAtomic(this.rp.runner, {
      schema: SCHEMAS.runner,
      run_id: this.runId,
      version: HYBRID_VERSION,
      node: process.version,
      pid: this.identity.pid,
      start_time: this.identity.start_time,
      status,
      started_at: this.startedAt,
      heartbeat_at: nowIso(),
      exit_reason: exitReason,
      hold: this.hold,
      counts: this.counts(),
      last_seq: this.seq,
    });
  }

  heartbeat() {
    if (Date.now() - this.lastHeartbeatMs < this.run.config.heartbeat_ms) return;
    try {
      this.run = loadRun(this.home, this.runId);
    } catch (err) {
      this.log(`could not re-read run.json: ${err.message}`);
    }
    this.writeRunnerJson(this.status);
  }

  checkIdle() {
    const c = this.counts();
    if (this.run.status !== 'open' && c.active === 0) {
      this.requestStop('run_closed');
      return;
    }
    // Queued jobs under a launch hold cannot progress until an owner unholds (which relaunches
    // the runner), so they do not keep this process alive.
    const launchable = this.hold ? 0 : c.queued;
    if (launchable > 0 || c.active > 0 || listPendingRequests(this.home, this.runId).length > 0) {
      this.idleSinceMs = null;
      return;
    }
    this.idleSinceMs ??= Date.now();
    if (Date.now() - this.idleSinceMs >= this.run.config.runner_idle_exit_minutes * this.mm) {
      this.requestStop('idle');
    }
  }

  // ---------- the single transition function ----------

  // `result` is a function (endedAt) => result object, required for terminal states.
  transition(job, to, { reason = null, detail = null, patch = {}, result = null } = {}) {
    const from = job.state.state;
    assertTransition(from, to);
    const now = nowIso();
    const seq = ++this.seq;
    const next = { ...job.state, ...patch, state: to, reason, detail, seq, updated_at: now };
    if (to === 'running' && from === 'launching') next.started_at = now;
    if (TERMINAL_STATES.has(to)) {
      next.ended_at = now;
      writeJsonAtomic(jobPaths(this.home, this.runId, job.id).result, result(now));
    }
    writeJsonAtomic(jobPaths(this.home, this.runId, job.id).state, next);
    job.state = next;
    try {
      appendTransition(this.home, this.runId, {
        seq, ts: now, kind: 'job', job_id: job.id, from, to, reason, attempt: next.attempt,
      });
    } catch (err) {
      this.log(`feed append failed for job ${job.id} seq ${seq}: ${err.message} (repaired on next start)`);
    }
    this.progress(`${job.id} ${from ?? '(new)'} -> ${to}${reason ? ` (${reason})` : ''}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
    return next;
  }

  // Non-transition update: persists state.json without touching seq.
  persist(job, patch = {}) {
    job.state = { ...job.state, ...patch, updated_at: nowIso() };
    writeJsonAtomic(jobPaths(this.home, this.runId, job.id).state, job.state);
  }

  setHold(reason, jobId) {
    if (this.hold) return;
    this.hold = { reason, since: nowIso(), job_id: jobId };
    this.writeRunnerJson(this.status);
    this.appendRunRecord('hold', reason);
  }

  clearHold() {
    this.hold = null;
    this.writeRunnerJson(this.status);
    this.appendRunRecord('unhold', 'unhold_requested');
  }

  appendRunRecord(to, reason) {
    const seq = ++this.seq;
    appendTransition(this.home, this.runId, { seq, ts: nowIso(), kind: 'run', job_id: null, from: null, to, reason });
    this.progress(`run ${to} (${reason})`);
  }

  specOf(job) {
    job.spec ??= readJobSpec(this.home, this.runId, job.id);
    return job.spec;
  }

  attemptOf(job) {
    return attemptPaths(this.home, this.runId, job.id, job.state.attempt);
  }

  // ---------- inbox ----------

  async processInbox() {
    const files = listPendingRequests(this.home, this.runId);
    if (files.length === 0) return;
    let run = this.run;
    try {
      run = loadRun(this.home, this.runId);
      this.run = run;
    } catch (err) {
      this.log(`could not re-read run.json for the inbox batch: ${err.message}`);
    }
    for (const file of files) {
      let request;
      try {
        request = readJson(file);
      } catch (err) {
        this.finishRequest(file, { id: path.basename(file, '.json'), malformed: true }, 'rejected', `malformed_request: ${err.message}`);
        continue;
      }
      let verdict;
      try {
        verdict = await this.handleRequest(request, run);
      } catch (err) {
        this.log(`request ${request.id} (${request.type}) failed: ${err.stack ?? err.message}`);
        verdict = { outcome: 'rejected', reason: `runner_error: ${err.message}` };
      }
      this.finishRequest(file, request, verdict.outcome, verdict.reason);
    }
  }

  finishRequest(file, request, outcome, reason) {
    try {
      completeRequest(this.home, this.runId, file, request, outcome, reason);
    } catch (err) {
      this.log(`could not complete request ${request.id}: ${err.message}`);
    }
  }

  async handleRequest(request, run) {
    const accept = (reason = null) => ({ outcome: 'accepted', reason });
    const reject = (reason) => ({ outcome: 'rejected', reason });
    if (request.run_id !== this.runId) return reject('wrong_run');
    if (run.status !== 'open' && request.type !== 'shutdown') return reject('run_closed');
    if (request.epoch !== run.owner.epoch) {
      if (request.type === 'submit') this.recordRejected(request, run, 'stale_epoch');
      return reject('stale_epoch');
    }
    switch (request.type) {
      case 'submit': return this.handleSubmit(request, run);
      case 'cancel': return this.handleCancel(request);
      case 'resume': return this.handleResume(request);
      case 'unhold':
        if (!this.hold) return accept('no_hold');
        this.clearHold();
        return accept();
      case 'shutdown':
        if (this.counts().active > 0) return reject('active_jobs');
        this.requestStop('shutdown_requested');
        return accept();
      default: return reject('unknown_type');
    }
  }

  newJobState(jobId, run, request, spec) {
    const now = nowIso();
    return {
      schema: SCHEMAS.jobState,
      run_id: this.runId,
      job_id: jobId,
      state: null,
      reason: null,
      detail: null,
      seq: 0,
      attempt: 1,
      mode: 'fresh',
      resume: null,
      submitted_epoch: spec?.submitted_epoch ?? request.epoch,
      created_at: now,
      updated_at: now,
      queued_at: null,
      started_at: null,
      ended_at: null,
      last_event_at: null,
      events_bytes: 0,
      worktree: worktreePath(run.config.worktree_root, this.runId, jobId),
      base_commit: spec?.base_commit ?? run.base_commit,
      process: null,
      codex_session_id: null,
      cancel_requested: false,
      timed_out: false,
      prompt_sha256: null,
    };
  }

  // Records a refused submit as a `rejected` job when its directory exists and holds no state yet.
  recordRejected(request, run, reason, detail = null) {
    const jobId = request.job_id;
    if (!JOB_ID_RE.test(jobId ?? '') || this.jobs.has(jobId)) return;
    const jp = jobPaths(this.home, this.runId, jobId);
    if (!exists(jp.dir) || exists(jp.state)) return;
    let spec = null;
    try {
      spec = readJobSpec(this.home, this.runId, jobId);
    } catch { /* an unreadable spec is part of why it is rejected */ }
    const job = this.makeJob(this.newJobState(jobId, run, request, spec));
    this.jobs.set(jobId, job);
    this.transition(job, 'rejected', {
      reason, detail, result: (endedAt) => this.bareResult(job, run, spec, { state: 'rejected', reason, detail }, endedAt),
    });
  }

  bareResult(job, run, spec, outcome, endedAt) {
    return buildResult({
      run, spec, state: job.state, outcome: { exit_source: 'none', ...outcome }, evidence: null, sweep: null, endedAt,
      specSha256: specSha256(jobPaths(this.home, this.runId, job.id).spec),
    });
  }

  handleSubmit(request, run) {
    const reject = (reason, detail) => {
      this.recordRejected(request, run, reason, detail);
      return { outcome: 'rejected', reason };
    };
    const jobId = request.job_id;
    if (!JOB_ID_RE.test(jobId ?? '')) return { outcome: 'rejected', reason: 'invalid_job_id' };
    const jp = jobPaths(this.home, this.runId, jobId);
    if (this.jobs.has(jobId) || exists(jp.state)) return { outcome: 'rejected', reason: 'job_exists' };
    if (!exists(jp.spec) || !exists(jp.capsule)) return reject('missing_inputs');
    let spec;
    try {
      spec = readJson(jp.spec);
    } catch (err) {
      return reject('invalid_spec', err.message);
    }
    if (spec.job_id !== jobId || spec.run_id !== this.runId) return reject('spec_mismatch');
    if (sha256File(jp.capsule) !== spec.capsule_sha256) return reject('capsule_hash_mismatch');
    const pinned = run.config.presets?.[spec.preset];
    if (!pinned || JSON.stringify(pinned) !== JSON.stringify(spec.preset_config)) return reject('preset_mismatch');

    const job = this.makeJob(this.newJobState(jobId, run, request, spec));
    job.spec = spec;
    this.jobs.set(jobId, job);
    this.transition(job, 'queued', { reason: 'submitted', patch: { queued_at: nowIso() } });
    return { outcome: 'accepted', reason: null };
  }

  async handleCancel(request) {
    const job = this.jobs.get(request.job_id);
    if (!job) return { outcome: 'rejected', reason: 'unknown_job' };
    const s = job.state.state;
    if (s === 'queued') {
      this.finishWithoutWorker(job, 'cancelled', 'cancel_requested');
    } else if (ACTIVE_STATES.has(s)) {
      this.persist(job, { cancel_requested: true });
      await this.killJob(job);
    } else {
      return { outcome: 'rejected', reason: 'not_active' };
    }
    return { outcome: 'accepted', reason: null };
  }

  handleResume(request) {
    const job = this.jobs.get(request.job_id);
    if (!job) return { outcome: 'rejected', reason: 'unknown_job' };
    const s = job.state;
    const reject = (reason) => ({ outcome: 'rejected', reason });
    if (!RESUMABLE_STATES.has(s.state)) return reject('not_resumable');
    if (!s.codex_session_id) return reject('no_session');
    if (!exists(s.worktree)) return reject('worktree_missing');
    return this.resumeJob(job, request);
  }

  async resumeJob(job, request) {
    const s = job.state;
    const alive = await areAlive([s.process?.host ?? null, s.process?.codex ?? null]);
    if (alive.some(Boolean)) return { outcome: 'rejected', reason: 'process_alive' };
    this.transition(job, 'queued', {
      reason: 'resume_requested',
      patch: {
        attempt: s.attempt + 1,
        mode: 'resume',
        resume: { note: request.payload?.note ?? null, from_state: s.state, from_reason: s.reason },
        queued_at: nowIso(),
        started_at: null,
        ended_at: null,
        last_event_at: null,
        events_bytes: 0,
        process: null,
        cancel_requested: false,
        timed_out: false,
        prompt_sha256: null,
      },
    });
    job.mon = this.makeJob(job.state).mon;
    return { outcome: 'accepted', reason: null };
  }

  // Terminal transition for a job that never had (or no longer has) a worker: no evidence to collect.
  finishWithoutWorker(job, state, reason, detail = null) {
    const run = this.run;
    this.transition(job, state, {
      reason, detail,
      result: (endedAt) => this.bareResult(job, run, this.specOf(job), { state, reason, detail }, endedAt),
    });
  }

  // ---------- monitor ----------

  // Per-job checks first; the identity checks of every job that is due then share ONE query.
  async monitorJobs() {
    const due = [];
    for (const job of this.jobs.values()) {
      if (!ACTIVE_STATES.has(job.state.state)) continue;
      try {
        if (await this.monitorJob(job)) due.push(job);
      } catch (err) {
        this.log(`monitor ${job.id}: ${err.stack ?? err.message}`);
      }
    }
    if (due.length === 0) return;
    try {
      await this.checkLiveness(due);
    } catch (err) {
      this.log(`liveness check failed: ${err.stack ?? err.message}`);
    }
  }

  // Returns true when the job is still active and its liveness is due for checking.
  async monitorJob(job) {
    const ap = this.attemptOf(job);
    const exit = readOptionalJson(ap.exit);
    if (job.state.state === 'launching') {
      const next = await this.advanceLaunch(job, ap, exit);
      if (next === 'liveness') return true;
      if (next !== 'promoted') return false;
      return this.monitorRunning(job, ap, readOptionalJson(ap.exit));
    }
    return this.monitorRunning(job, ap, exit);
  }

  // 'promoted' (monitor as running), 'liveness' (cancelled while launching), 'wait' or 'done'.
  async advanceLaunch(job, ap, exit) {
    const s = job.state;
    if (exit && (exit.spawn_error || s.cancel_requested)) {
      await this.finalizeJob(job);
      return 'done';
    }
    const hostRecord = readOptionalJson(ap.host);
    if (hostRecord && !s.cancel_requested) {
      this.transition(job, 'running', {
        reason: 'host_recorded',
        patch: { process: { host: hostRecord.host, codex: hostRecord.codex } },
      });
      job.mon.nextLivenessMs = 0;
      job.mon.lastEventMs = null;
      return 'promoted';
    }
    if (s.cancel_requested) return this.livenessDue(job) ? 'liveness' : 'wait';
    if (job.mon.launchDeadlineMs !== null && Date.now() > job.mon.launchDeadlineMs) {
      await this.killJob(job);
      if (job.mon.launchedHere) {
        await this.finalizeJob(job, {
          state: 'failed', reason: 'launch_failed',
          detail: `job host did not report within ${LAUNCH_WAIT_MS / 1000}s`, exit_source: 'none',
        });
      } else {
        await this.finalizeJob(job, {
          state: 'interrupted', reason: 'launch_uncertain',
          detail: 'launch outcome unknown after a runner restart', exit_source: 'none',
        });
      }
      return 'done';
    }
    return 'wait';
  }

  async monitorRunning(job, ap, exit) {
    if (exit) {
      await this.finalizeJob(job);
      return false;
    }
    const now = Date.now();
    this.trackEvents(job, ap, now);
    const flagged = job.state.cancel_requested || job.state.timed_out;
    if (!flagged) {
      const spec = this.specOf(job);
      const ref = job.mon.lastEventMs ?? parseMs(job.state.started_at);
      if (job.state.state === 'running' && now - ref > spec.stall_minutes * this.mm) {
        this.transition(job, 'stalled', { reason: 'no_events' });
      }
      if (now - parseMs(job.state.started_at) > spec.timeout_minutes * this.mm) {
        this.persist(job, { timed_out: true });
        await this.killJob(job);
      }
    }
    return this.livenessDue(job);
  }

  trackEvents(job, ap, now) {
    const size = fileSize(ap.events) ?? 0;
    const mon = job.mon;
    if (size <= mon.eventsSeen) return;
    mon.eventsSeen = size;
    mon.lastEventMs = now;
    const patch = { last_event_at: iso(now), events_bytes: size };
    let persistNow = now - mon.lastPersistMs >= EVENT_PERSIST_MS;
    if (!job.state.codex_session_id) {
      const threadId = this.readThreadId(ap);
      if (threadId) {
        patch.codex_session_id = threadId;
        persistNow = true;
      }
    }
    if (job.state.state === 'stalled') {
      this.transition(job, 'running', { reason: 'events_resumed', patch });
      mon.lastPersistMs = now;
    } else if (persistNow) {
      this.persist(job, patch);
      mon.lastPersistMs = now;
    }
  }

  readThreadId(ap) {
    const { records } = readJsonlFrom(ap.events, 0);
    return records.find((r) => r?.type === 'thread.started' && typeof r.thread_id === 'string')?.thread_id ?? null;
  }

  // Flagged (cancel/timeout) jobs are checked every tick; others every liveness_check_ms.
  livenessDue(job) {
    const flagged = job.state.cancel_requested || job.state.timed_out;
    const now = Date.now();
    if (!flagged && now < job.mon.nextLivenessMs) return false;
    job.mon.nextLivenessMs = now + this.run.config.liveness_check_ms;
    return true;
  }

  // Both host and Codex gone and still no exit.json -> finalize. A flagged job that is somehow
  // still alive is killed again.
  async checkLiveness(jobs) {
    const identities = jobs.flatMap((j) => [j.state.process?.host ?? null, j.state.process?.codex ?? null]);
    const alive = await areAlive(identities);
    for (const [i, job] of jobs.entries()) {
      const flagged = job.state.cancel_requested || job.state.timed_out;
      try {
        if (alive[2 * i] || alive[2 * i + 1]) {
          if (flagged && Date.now() - job.mon.lastKillMs > RE_KILL_MS) await this.killJob(job);
        } else if (!readOptionalJson(this.attemptOf(job).exit)) {
          // (an exit.json that appeared meanwhile is finalized, with its contents, on the next tick)
          await this.finalizeJob(job);
        }
      } catch (err) {
        this.log(`liveness ${job.id}: ${err.stack ?? err.message}`);
      }
    }
  }

  // Host tree first, then Codex tree; both identity-verified, never by bare PID.
  async killJob(job) {
    job.mon.lastKillMs = Date.now();
    for (const identity of [job.state.process?.host, job.state.process?.codex]) {
      if (!identity) continue;
      try {
        const r = await killTree(identity);
        this.log(`kill ${job.id} pid ${identity.pid}: ${JSON.stringify({ ...r, output: undefined })}`);
      } catch (err) {
        this.log(`kill ${job.id} pid ${identity.pid} failed: ${err.message}`);
      }
    }
  }

  // ---------- finalize ----------

  // proc.sweepOrphans matches at a path boundary, so ...\j1 never sweeps ...\j10.
  async sweepPath(needle) {
    const { killed, failed } = await sweepOrphans(needle, { excludePids: [process.pid] });
    return { killed, failed };
  }

  async sweepJob(job) {
    const needles = [job.state.worktree];
    // A launch that never reported may still have a host nobody has an identity for.
    if (job.state.state === 'launching') needles.push(this.attemptOf(job).dir);
    const total = { killed: [], failed: [] };
    for (const needle of needles) {
      try {
        const r = await this.sweepPath(needle);
        total.killed.push(...r.killed);
        total.failed.push(...r.failed);
      } catch (err) {
        total.failed.push({ identity: null, reason: `sweep ${needle}: ${err.message}` });
      }
    }
    return total;
  }

  async finalizeJob(job, forced = null) {
    try {
      await this.finalizeJobUnsafe(job, forced);
    } catch (err) {
      const mon = job.mon;
      mon.finalizeFailures++;
      this.log(`finalize ${job.id} failed (${mon.finalizeFailures}/${MAX_FINALIZE_FAILURES}): ${err.stack ?? err.message}`);
      if (mon.finalizeFailures >= MAX_FINALIZE_FAILURES && ACTIVE_STATES.has(job.state.state)) {
        this.finishWithoutWorker(job, 'interrupted', 'finalize_failed', err.message);
      }
    }
  }

  async finalizeJobUnsafe(job, forced) {
    const s = job.state;
    const spec = this.specOf(job);
    const ap = this.attemptOf(job);
    const sweep = await this.sweepJob(job);
    const evidence = collectEvidence({ run: this.run, spec, state: s, ap, ctx: this.ctx, worktree: s.worktree });
    const outcome = forced ?? decideOutcome({
      cancelRequested: s.cancel_requested,
      timedOut: s.timed_out,
      exit: evidence.exit,
      events: evidence.events,
      finalMessage: evidence.finalMessage,
      classification: evidence.classification,
      patchFailed: evidence.patch.verdict === 'capture_failed',
    });
    if (outcome.state === 'paused_quota') this.setHold('quota', job.id);
    if (outcome.state === 'paused_auth') this.setHold('auth', job.id);

    const sessionId = s.codex_session_id ?? evidence.threadId;
    const lastEventAt = job.mon.lastEventMs ? iso(job.mon.lastEventMs) : (s.last_event_at ?? this.eventsMtime(ap));
    const patch = { codex_session_id: sessionId, last_event_at: lastEventAt, events_bytes: fileSize(ap.events) ?? 0 };
    const launch = readOptionalJson(ap.launch);
    const sha = specSha256(jobPaths(this.home, this.runId, job.id).spec);
    this.transition(job, outcome.state, {
      reason: outcome.reason,
      detail: outcome.detail,
      patch,
      result: (endedAt) => buildResult({
        run: this.run, spec, state: { ...s, ...patch }, outcome, evidence, sweep, endedAt, launch, specSha256: sha,
      }),
    });
  }

  // A fast worker can finish before the monitor ever saw its events; the file's mtime is the best evidence.
  eventsMtime(ap) {
    try {
      return fs.statSync(ap.events).mtime.toISOString();
    } catch {
      return null;
    }
  }

  // ---------- launch ----------

  async launchQueued() {
    if (this.hold || this.exitReason) return;
    const max = this.run.config.max_concurrency;
    const queued = [...this.jobs.values()]
      .filter((j) => j.state.state === 'queued')
      .sort((a, b) => (a.state.queued_at < b.state.queued_at ? -1 : a.state.queued_at > b.state.queued_at ? 1 : a.id.localeCompare(b.id)));
    for (const job of queued) {
      if (this.hold || this.counts().active >= max) return;
      await this.launch(job);
    }
  }

  async launch(job) {
    const resume = job.state.mode === 'resume';
    this.transition(job, 'launching', {
      reason: resume ? 'resume' : 'slot_free',
      patch: { started_at: null, ended_at: null },
    });
    try {
      await this.prepareAndSpawn(job);
    } catch (err) {
      this.log(`launch ${job.id} failed: ${err.stack ?? err.message}`);
      await this.finalizeJob(job, {
        state: 'failed', reason: err.reason ?? 'launch_failed', detail: err.message, exit_source: 'none',
      });
    }
  }

  async prepareAndSpawn(job) {
    const run = this.run;
    const s = job.state;
    const spec = this.specOf(job);
    const ap = this.attemptOf(job);
    const resume = s.mode === 'resume';

    ensureDir(ap.dir);
    if (exists(ap.launch)) throw new Error(`attempt directory already holds launch.json: ${ap.dir}`);

    // Codex injects CODEX_HOME's global AGENTS.md into every worker and cannot be told not to;
    // run start pinned it, so a mid-run change refuses the launch (before any worktree exists).
    const pinned = run.global_instructions ?? null;
    const globalInstructions = readGlobalInstructions(
      pinned?.codex_home ?? run.config.codex_home ?? defaultCodexHome(process.env),
    );
    if (pinned && globalInstructions.fingerprint !== pinned.fingerprint) {
      throw Object.assign(new Error(
        `global Codex instructions changed since run start: pinned ${describeGlobalInstructions(pinned)}, `
          + `now ${describeGlobalInstructions(globalInstructions)}`,
      ), { reason: 'global_instructions_changed' });
    }

    if (resume) {
      if (!exists(s.worktree)) throw new Error(`worktree missing for resume: ${s.worktree}`);
    } else {
      git.createWorktree(this.ctx, { repo: run.repo.path, worktree: s.worktree, baseCommit: s.base_commit });
      git.prepareWorktree(this.ctx, { repo: run.repo.path, worktree: s.worktree, prepare: run.repo.prepare });
    }

    const prompt = resume
      ? composeResumePrompt({
        runId: this.runId, jobId: job.id, spec, reason: `${s.resume.from_state}/${s.resume.from_reason}`, note: s.resume.note,
      })
      : composePrompt({
        runId: this.runId, jobId: job.id, baseCommit: s.base_commit, spec,
        capsuleText: readText(jobPaths(this.home, this.runId, job.id).capsule),
      });
    writeFileExclusive(ap.prompt, prompt);
    this.persist(job, { prompt_sha256: sha256(prompt) });

    const { model, effort, sandbox } = spec.preset_config;
    const common = {
      model, effort, sandbox, lastMessageFile: ap.lastMessage,
      outputSchemaFile: run.config.output_schema ? WORKER_OUTPUT_SCHEMA : null,
      windowsSandbox: run.config.windows_sandbox, projectDocs: run.config.project_docs,
    };
    const args = resume
      ? buildResumeArgs({ ...common, sessionId: s.codex_session_id })
      : buildExecArgs({ ...common, worktree: s.worktree });
    const workerEnv = buildWorkerEnv(process.env, {
      nodeDir: path.dirname(process.execPath),
      gitDirs: git.gitInstallDirs(run.tools.git_exe),
      extraPath: run.config.extra_path,
      codexHome: run.config.codex_home,
    });
    writeJsonAtomic(ap.launch, {
      schema: SCHEMAS.launch,
      run_id: this.runId,
      job_id: job.id,
      attempt: s.attempt,
      mode: s.mode,
      exe: run.config.codex_exe,
      args: [...run.config.codex_prefix_args, ...args],
      cwd: s.worktree,
      env: workerEnv.env,
      env_names: Object.keys(workerEnv.env).sort(),
      path_entries: workerEnv.path_entries,
      dropped_path_entries: workerEnv.dropped_path_entries,
      global_instructions: globalInstructions,
      stdin_file: ap.prompt,
      stdout_file: ap.events,
      stderr_file: ap.stderr,
      created_at: nowIso(),
    });

    const host = spawn(process.execPath, [JOB_HOST_ENTRY, ap.dir], {
      detached: true, windowsHide: true, stdio: 'ignore', cwd: ap.dir, env: workerEnv.env,
    });
    host.on('error', (err) => this.log(`job host spawn error for ${job.id}: ${err.message}`));
    host.unref();
    if (!host.pid) throw new Error('job host could not be spawned');
    job.mon.launchedHere = true;
    job.mon.launchDeadlineMs = Date.now() + LAUNCH_WAIT_MS;
    const hostIdentity = await getIdentity(host.pid);
    this.persist(job, { process: { host: hostIdentity, codex: null } });
  }
}
