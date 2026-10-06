import fs from 'node:fs';
import path from 'node:path';
import { HYBRID_VERSION, SCHEMAS, V1_MAX_CONCURRENCY } from '../../constants.mjs';
import { homePaths, runPaths } from '../../paths.mjs';
import { buildRunConfig, loadMachineConfig } from '../../config.mjs';
import { codexVersion } from '../../codex.mjs';
import { defaultCodexHome } from '../../rollout.mjs';
import { describeGlobalInstructions, readGlobalInstructions } from '../../instructions.mjs';
import * as git from '../../git.mjs';
import { ensureDir, nowIso, readJson, tryCreateLock, withMutex, writeFileExclusive, writeJsonAtomic } from '../../fsutil.mjs';
import * as store from '../../store.mjs';
import { ensureRunner, runnerAlive } from '../../launcher.mjs';
import {
  ageSince, awaitOutcome, conflictError, notFoundError, outcomeResult, requirePositionals,
  selectOwnedRun, selectRun, sessionOrAnon, startRunner, truncate, usageError, workSummary,
} from '../util.mjs';

const STALE_LOCK_GRACE_MS = 30_000;

function planTemplate({ runId, baseCommit, createdAt }) {
  return [
    `# Plan: run ${runId}`,
    '',
    `Base commit: ${baseCommit}`,
    `Created: ${createdAt}`,
    '',
    '> plan.md is owned by Opus and is never read by the runner.',
    '',
    '## Goal',
    '',
    '## Decomposition',
    '',
    '## Decisions',
    '',
    '## Jobs',
    '',
    '## Integration log',
    '',
    '## Remaining work',
    '',
  ].join('\n');
}

// Takes the global one-active-run lock, breaking it once if it is stale (its run is gone or closed).
function acquireActiveRunLock(home, meta) {
  const lockFile = homePaths(home).activeRunLock;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreateLock(lockFile, meta)) return;
    let held;
    try {
      held = readJson(lockFile, { optional: true });
    } catch {
      throw conflictError(`active-run.json exists but is unreadable: ${lockFile}`);
    }
    if (held) {
      const run = held.run_id ? readJson(runPaths(home, held.run_id).run, { optional: true }) : null;
      // A missing run.json is only stale after a grace period: a concurrent `run start` writes the lock first.
      const young = (ageSince(held.created_at) ?? Infinity) < STALE_LOCK_GRACE_MS;
      const stale = run ? run.status === 'closed' : !young;
      if (!stale) {
        throw conflictError(
          `Run ${held.run_id} is already active (owner session ${run?.owner?.session_id ?? held.session_id ?? 'unknown'}). `
          + 'Close it (hybrid run close) or take it over (hybrid takeover).',
        );
      }
    }
    fs.rmSync(lockFile, { force: true });
  }
  throw conflictError('Could not take the active-run lock (another `run start` won the race)');
}

export const runStart = {
  usage: 'run start --repo <alias> [--base <ref>] [--goal <text>] [--concurrency <n>]',
  options: {
    repo: { type: 'string' }, base: { type: 'string' }, goal: { type: 'string' }, concurrency: { type: 'string' },
  },
  async run(c) {
    requirePositionals(c, 0);
    const { home, values } = c;
    if (!values.repo) throw usageError('--repo <alias> is required');
    let concurrency;
    if (values.concurrency !== undefined) {
      concurrency = /^\d+$/.test(values.concurrency) ? Number(values.concurrency) : NaN;
      if (!(concurrency >= 1 && concurrency <= V1_MAX_CONCURRENCY)) {
        throw usageError(`--concurrency must be an integer from 1 to ${V1_MAX_CONCURRENCY}`);
      }
    }
    const session = sessionOrAnon(c);

    const machine = loadMachineConfig(home);
    const repo = machine.repos[values.repo];
    if (!repo) throw notFoundError(`Unknown repo alias "${values.repo}" (hybrid repo add <alias> <path>)`);
    const config = buildRunConfig(machine, { concurrency });
    const hp = homePaths(home);
    ensureDir(home);
    const gitExe = git.resolveGitExe();
    const ctx = { gitExe, hooksDir: git.ensureEmptyHooksDir(hp.emptyHooks) };
    if (path.resolve(git.repoTopLevel(ctx, repo.path)).toLowerCase() !== path.resolve(repo.path).toLowerCase()) {
      throw usageError(`Repo path is not a git repository root: ${repo.path}`);
    }
    const baseRef = values.base ?? 'HEAD';
    let baseCommit;
    try {
      baseCommit = git.resolveCommit(ctx, repo.path, baseRef);
    } catch (err) {
      throw usageError(err.message);
    }
    const versions = {
      hybrid: HYBRID_VERSION,
      node: process.version,
      git: git.gitVersion(ctx),
      codex: codexVersion({ exe: config.codex_exe, prefixArgs: config.codex_prefix_args }),
    };

    // Pinned so the runner can refuse launches if it changes mid-run (src/instructions.mjs).
    const globalInstructions = readGlobalInstructions(config.codex_home ?? defaultCodexHome());
    if (globalInstructions.present) {
      c.warnings.push(`global Codex instructions ${describeGlobalInstructions(globalInstructions)} reach every worker `
        + '(Codex has no switch to exclude them); pinned for this run');
    }

    const runId = store.generateRunId();
    const createdAt = nowIso();
    const rp = runPaths(home, runId);
    acquireActiveRunLock(home, { run_id: runId, created_at: createdAt, session_id: session });
    try {
      ensureDir(hp.runs);
      fs.mkdirSync(rp.dir);
      for (const dir of [rp.inboxDone, rp.jobs, rp.cursors]) ensureDir(dir);
      writeJsonAtomic(rp.run, {
        schema: SCHEMAS.run,
        run_id: runId,
        status: 'open',
        created_at: createdAt,
        closed_at: null,
        goal: values.goal ?? '',
        repo: { alias: values.repo, path: repo.path, prepare: repo.prepare },
        base_ref: baseRef,
        base_commit: baseCommit,
        owner: { session_id: session, epoch: 1, acquired_at: createdAt },
        owner_history: [],
        versions,
        tools: { node_exe: process.execPath, git_exe: gitExe },
        config,
        global_instructions: globalInstructions,
      });
      writeFileExclusive(rp.plan, planTemplate({ runId, baseCommit, createdAt }));
    } catch (err) {
      fs.rmSync(rp.dir, { recursive: true, force: true });
      fs.rmSync(hp.activeRunLock, { force: true });
      throw err;
    }

    const runner = await startRunner(home, runId, `Run ${runId} created (epoch 1)`);
    const runnerText = runner.skipped ? 'not launched (HYBRID_RUNNER_LAUNCH=none)' : `pid ${runner.pid}`;
    return {
      data: {
        run_id: runId, epoch: 1, session_id: session, base_commit: baseCommit, run_dir: rp.dir, plan: rp.plan,
        runner_pid: runner.pid, global_instructions: globalInstructions,
      },
      text: [
        `run_id: ${runId}`, 'epoch: 1', `session: ${session}`, `base_commit: ${baseCommit}`,
        `run_dir: ${rp.dir}`, `plan: ${rp.plan}`, `runner: ${runnerText}`,
        `global_instructions: ${describeGlobalInstructions(globalInstructions)}`,
      ].join('\n'),
    };
  },
};

export const runList = {
  usage: 'run list',
  options: {},
  run(c) {
    requirePositionals(c, 0);
    const active = store.readActiveRunLock(c.home)?.run_id ?? null;
    let ids = [];
    try {
      ids = fs.readdirSync(homePaths(c.home).runs);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const runs = [];
    for (const id of ids) {
      let run = null;
      try {
        run = readJson(runPaths(c.home, id).run, { optional: true });
      } catch { /* unreadable: skip */ }
      if (run) {
        runs.push({
          run_id: run.run_id, status: run.status, created_at: run.created_at, epoch: run.owner.epoch,
          owner_session: run.owner.session_id, goal: run.goal, active: run.run_id === active,
        });
      }
    }
    runs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return {
      data: { runs },
      text: runs.length
        ? runs.map((r) => `${r.active ? '*' : ' '} ${r.run_id} ${r.status} epoch=${r.epoch} ${r.created_at} ${truncate(r.goal, 60)}`).join('\n')
        : '(no runs)',
    };
  },
};

export const runClose = {
  usage: 'run close --epoch <n>',
  options: { epoch: { type: 'string' } },
  async run(c) {
    requirePositionals(c, 0);
    const { runId, rp } = selectOwnedRun(c);
    const { epoch, closedAt } = withMutex(rp.runMutex, () => {
      const run = store.loadRun(c.home, runId);
      const ownedEpoch = store.assertOwner(run, c.values.epoch);
      const work = workSummary(c.home, runId);
      if (work.nonTerminal.length || work.requests) {
        const parts = [];
        if (work.nonTerminal.length) parts.push(`non-terminal jobs: ${work.nonTerminal.join(', ')}`);
        if (work.requests) parts.push(`${work.requests} pending request(s)`);
        throw conflictError(`Cannot close run ${runId}: ${parts.join('; ')}`);
      }
      const at = nowIso();
      writeJsonAtomic(rp.run, { ...run, status: 'closed', closed_at: at });
      return { epoch: ownedEpoch, closedAt: at };
    });
    if ((await runnerAlive(c.home, runId)).alive) {
      store.writeRequest(c.home, runId, { type: 'shutdown', epoch, session_id: c.session });
    }
    if (store.readActiveRunLock(c.home)?.run_id === runId) {
      fs.rmSync(homePaths(c.home).activeRunLock, { force: true });
    }
    return { data: { run_id: runId, status: 'closed', closed_at: closedAt }, text: `run ${runId} closed` };
  },
};

export const runUnhold = {
  usage: 'run unhold --epoch <n>',
  options: { epoch: { type: 'string' } },
  async run(c) {
    requirePositionals(c, 0);
    const { runId, epoch } = selectOwnedRun(c);
    const request = store.writeRequest(c.home, runId, { type: 'unhold', epoch, session_id: c.session });
    await startRunner(c.home, runId, `Unhold request ${request.id} queued`);
    return outcomeResult('unhold', request, await awaitOutcome(c.home, runId, request.id));
  },
};

export const runEnsureRunner = {
  usage: 'run ensure-runner --epoch <n>',
  options: { epoch: { type: 'string' } },
  async run(c) {
    requirePositionals(c, 0);
    const { runId } = selectOwnedRun(c);
    const r = await ensureRunner(c.home, runId);
    return {
      data: { run_id: runId, already_running: r.already, pid: r.pid, skipped: !!r.skipped },
      text: r.skipped
        ? 'runner: not launched (HYBRID_RUNNER_LAUNCH=none)'
        : `runner: pid ${r.pid} (${r.already ? 'already running' : 'started'})`,
    };
  },
};

export const takeover = {
  usage: 'takeover [--session <id>]',
  options: {},
  run(c) {
    requirePositionals(c, 0);
    const session = sessionOrAnon(c);
    const { runId, rp } = selectRun(c);
    const owner = withMutex(rp.runMutex, () => {
      const run = store.loadRun(c.home, runId);
      if (run.status !== 'open') throw conflictError(`Run ${runId} is ${run.status}`);
      const at = nowIso();
      const next = { session_id: session, epoch: run.owner.epoch + 1, acquired_at: at };
      writeJsonAtomic(rp.run, {
        ...run,
        owner: next,
        owner_history: [...run.owner_history, { ...run.owner, released_at: at }],
      });
      return next;
    });
    return {
      data: { run_id: runId, epoch: owner.epoch, session_id: session },
      text: `run ${runId}: you are owner, epoch ${owner.epoch} (session ${session}). `
        + 'Re-ground from plan.md and `hybrid status` before acting.',
    };
  },
};
