// Central, frozen v1 contracts: schema ids, job states and the legal transitions between them.
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const HYBRID_VERSION = pkg.version;

export const SCHEMAS = Object.freeze({
  run: 'hybrid.run/1',
  runner: 'hybrid.runner/1',
  jobSpec: 'hybrid.job-spec/1',
  jobState: 'hybrid.job-state/1',
  jobResult: 'hybrid.job-result/1',
  request: 'hybrid.request/1',
  decision: 'hybrid.decision/1',
  launch: 'hybrid.launch/1',
  host: 'hybrid.host/1',
  exit: 'hybrid.exit/1',
  controller: 'hybrid.controller/1',
  controllerLaunch: 'hybrid.controller-launch/1',
  machineConfig: 'hybrid.config/1',
});

// v1 never runs more than this many Codex workers at once, whatever the config says.
export const V1_MAX_CONCURRENCY = 8;

export const STATES = Object.freeze({
  queued: 'queued',
  launching: 'launching',
  running: 'running',
  stalled: 'stalled',
  completed: 'completed',
  failed: 'failed',
  interrupted: 'interrupted',
  cancelled: 'cancelled',
  paused_quota: 'paused_quota',
  paused_auth: 'paused_auth',
  rejected: 'rejected',
});

// Occupy a concurrency slot (a process may exist).
export const ACTIVE_STATES = new Set(['launching', 'running', 'stalled']);
// No process exists and none will be started without an explicit owner request.
export const TERMINAL_STATES = new Set([
  'completed', 'failed', 'interrupted', 'cancelled', 'paused_quota', 'paused_auth', 'rejected',
]);
// States from which `hybrid resume` may queue a new attempt of the same Codex session.
export const RESUMABLE_STATES = new Set(['interrupted', 'failed', 'cancelled', 'paused_quota', 'paused_auth']);
// States that wake a waiting Opus.
export const WAKE_STATES = new Set([...TERMINAL_STATES, 'stalled']);

// `null` is the pseudo-state before the runner first records a job.
export const TRANSITIONS = Object.freeze({
  null: ['queued', 'rejected'],
  queued: ['launching', 'cancelled'],
  launching: ['running', 'failed', 'interrupted', 'cancelled'],
  running: ['stalled', 'completed', 'failed', 'interrupted', 'cancelled', 'paused_quota', 'paused_auth'],
  stalled: ['running', 'completed', 'failed', 'interrupted', 'cancelled', 'paused_quota', 'paused_auth'],
  failed: ['queued'],
  interrupted: ['queued'],
  cancelled: ['queued'],
  paused_quota: ['queued'],
  paused_auth: ['queued'],
  completed: [],
  rejected: [],
});

export function canTransition(from, to) {
  if (from === 'null') return false; // only a real null means "not yet recorded"
  const allowed = TRANSITIONS[from === null || from === undefined ? 'null' : from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal job transition ${from ?? '(new)'} -> ${to}`);
  }
}

export const DECISIONS = Object.freeze(['integrated', 'rejected', 'superseded', 'deferred']);

export const REQUEST_TYPES = Object.freeze(['submit', 'cancel', 'resume', 'unhold', 'shutdown']);

// CLI exit codes (documented in docs/CLI.md).
export const EXIT = Object.freeze({
  ok: 0,
  error: 1,
  usage: 2,
  fenced: 3,
  notFound: 4,
  conflict: 5,
  waitTimeout: 10,
});

// Identifier grammars. Short on purpose: they become Windows path segments.
export const RUN_ID_RE = /^r\d{6}-\d{6}-[0-9a-f]{4}$/;
export const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const SHA1_RE = /^[0-9a-f]{40}$/;
