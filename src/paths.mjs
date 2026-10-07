// On-disk layout. Every path the system uses is derived here so the layout lives in one place.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNNER_ENTRY = path.join(PACKAGE_ROOT, 'src', 'runner', 'main.mjs');
export const JOB_HOST_ENTRY = path.join(PACKAGE_ROOT, 'src', 'runner', 'job-host.mjs');
export const CONTROLLER_HOST_ENTRY = path.join(PACKAGE_ROOT, 'src', 'runner', 'controller-host.mjs');
export const CLI_ENTRY = path.join(PACKAGE_ROOT, 'bin', 'hybrid.mjs');
export const ORCHESTRATION_DOC = path.join(PACKAGE_ROOT, 'docs', 'ORCHESTRATION.md');
export const WORKER_OUTPUT_SCHEMA = path.join(PACKAGE_ROOT, 'schemas', 'worker-output.schema.json');

// State root: HYBRID_HOME, else %LOCALAPPDATA%\HybridWorkflow.
export function resolveHome(env = process.env) {
  if (env.HYBRID_HOME) return path.resolve(env.HYBRID_HOME);
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'HybridWorkflow');
}

// Short worktree root to stay clear of MAX_PATH: %SystemDrive%\hw\wt by default.
export function defaultWorktreeRoot(env = process.env) {
  const drive = env.SystemDrive || env.SYSTEMDRIVE || 'C:';
  return path.join(`${drive}\\`, 'hw', 'wt');
}

// Shared Playwright install readable by the Codex sandbox accounts: %SystemDrive%\hw\ms-playwright.
export function defaultPlaywrightDir(env = process.env) {
  const drive = env.SystemDrive || env.SYSTEMDRIVE || 'C:';
  return path.join(`${drive}\\`, 'hw', 'ms-playwright');
}

// Shared npm cache workers may write (a Codex writable root): %SystemDrive%\hw\npm-cache.
export function defaultNpmCacheDir(env = process.env) {
  const drive = env.SystemDrive || env.SYSTEMDRIVE || 'C:';
  return path.join(`${drive}\\`, 'hw', 'npm-cache');
}

export function homePaths(home) {
  return {
    home,
    config: path.join(home, 'config.json'),
    activeRunLock: path.join(home, 'active-run.json'),
    emptyHooks: path.join(home, 'empty-hooks'),
    runs: path.join(home, 'runs'),
  };
}

export function runPaths(home, runId) {
  const dir = path.join(home, 'runs', runId);
  return {
    dir,
    run: path.join(dir, 'run.json'),
    runMutex: path.join(dir, 'run.mutex'),
    plan: path.join(dir, 'plan.md'),
    runner: path.join(dir, 'runner.json'),
    runnerLock: path.join(dir, 'runner.lock'),
    runnerLog: path.join(dir, 'runner.log'),
    runnerLaunch: path.join(dir, 'runner-launch.json'),
    transitions: path.join(dir, 'transitions.jsonl'),
    progress: path.join(dir, 'progress.log'),
    inbox: path.join(dir, 'inbox'),
    inboxTmp: path.join(dir, 'inbox', '.tmp'),
    inboxDone: path.join(dir, 'inbox', 'done'),
    cursors: path.join(dir, 'cursors'),
    jobs: path.join(dir, 'jobs'),
    controller: path.join(dir, 'controller.json'),
    controllers: path.join(dir, 'controllers'),
  };
}

export function jobPaths(home, runId, jobId) {
  const dir = path.join(home, 'runs', runId, 'jobs', jobId);
  return {
    dir,
    spec: path.join(dir, 'spec.json'),
    capsule: path.join(dir, 'capsule.md'),
    state: path.join(dir, 'state.json'),
    result: path.join(dir, 'result.json'),
    decision: path.join(dir, 'decision.json'),
    attempts: path.join(dir, 'attempts'),
  };
}

export function attemptPaths(home, runId, jobId, attempt) {
  const dir = path.join(home, 'runs', runId, 'jobs', jobId, 'attempts', String(attempt));
  return {
    dir,
    launch: path.join(dir, 'launch.json'),
    prompt: path.join(dir, 'prompt.md'),
    host: path.join(dir, 'host.json'),
    exit: path.join(dir, 'exit.json'),
    events: path.join(dir, 'events.jsonl'),
    stderr: path.join(dir, 'stderr.log'),
    lastMessage: path.join(dir, 'last-message.md'),
    hostLog: path.join(dir, 'host.log'),
    patch: path.join(dir, 'patch.diff'),
    patchMeta: path.join(dir, 'patch.json'),
  };
}

export function worktreePath(worktreeRoot, runId, jobId) {
  return path.join(worktreeRoot, runId, jobId);
}
