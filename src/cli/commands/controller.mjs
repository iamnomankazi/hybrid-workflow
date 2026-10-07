import fs from 'node:fs';
import path from 'node:path';
import { SCHEMAS } from '../../constants.mjs';
import { CLI_ENTRY, CONTROLLER_HOST_ENTRY, ORCHESTRATION_DOC, homePaths } from '../../paths.mjs';
import { ensureDir, nowIso, sleep, writeFileExclusive, writeJsonAtomic } from '../../fsutil.mjs';
import { codexVersion } from '../../codex.mjs';
import * as git from '../../git.mjs';
import {
  CONTROLLER_KEEPALIVE_MS, CONTROLLER_PROFILE, buildControllerArgs, controllerAttached, controllerPrompt,
  controllerShellEnv, readController, validateExtraRoot,
} from '../../controller.mjs';
import { ensureRunner, launchMode, launchNode } from '../../launcher.mjs';
import { HybridError } from '../../store.mjs';
import { conflictError, requirePositionals, selectOwnedRun, usageError } from '../util.mjs';

const READY_TIMEOUT_MS = 30_000;

function nextControllerDir(rp) {
  ensureDir(rp.controllers);
  const used = fs.readdirSync(rp.controllers).filter((n) => /^\d+$/.test(n)).map(Number);
  const n = used.length ? Math.max(...used) + 1 : 1;
  return { n, dir: path.join(rp.controllers, String(n)) };
}

function gitCommonDir(home, run, repo) {
  const ctx = { gitExe: run.tools?.git_exe ?? git.resolveGitExe(), hooksDir: homePaths(home).emptyHooks };
  const out = git.runGit(ctx, ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
  return path.resolve(out);
}

export const controllerStart = {
  usage: 'controller start --epoch <n> [--writable <dir>]... [--dry-run]',
  options: { epoch: { type: 'string' }, writable: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' } },
  async run(c) {
    requirePositionals(c, 0);
    const { runId, run, rp, epoch } = selectOwnedRun(c);
    const repo = run.repo.path;

    const current = readController(rp.controller);
    if (controllerAttached(current)) {
      throw conflictError(`A controller is already running for run ${runId} (session ${current.session_id}, `
        + `host pid ${current.host?.pid ?? '?'}). Take over to stop it, or wait for it to finish.`);
    }
    if (!fs.existsSync(rp.plan)) throw conflictError(`plan.md is missing: ${rp.plan}`);

    const extra = [];
    for (const dir of c.values.writable ?? []) {
      const problem = validateExtraRoot(dir, { repo, home: c.home, userProfile: c.env.USERPROFILE });
      if (problem) throw usageError(`--writable ${problem}`);
      extra.push(path.resolve(dir));
    }
    const writableRoots = [rp.dir, gitCommonDir(c.home, run, repo), ...extra];

    const codexNow = codexVersion({ exe: run.config.codex_exe, prefixArgs: run.config.codex_prefix_args });
    if (codexNow !== run.versions.codex) {
      throw conflictError(`Codex is now ${codexNow}, but this run pinned ${run.versions.codex}; refusing to launch a controller`);
    }

    const { n, dir } = nextControllerDir(rp);
    const sessionId = `sol-controller-${n}`;
    // Git trust (not write access) also covers the main repository: `hybrid submit` validates
    // base_commit there, and git refuses a repository owned by another account.
    const shellEnv = controllerShellEnv({ home: c.home, sessionId, safeDirectories: [...writableRoots, repo] });
    const lastMessageFile = path.join(dir, 'last-message.md');
    const args = [
      ...run.config.codex_prefix_args,
      ...buildControllerArgs({ cwd: rp.dir, writableRoots: writableRoots.slice(1), lastMessageFile, shellEnv }),
    ];
    const prompt = controllerPrompt({
      runId, home: c.home, sessionId, startEpoch: epoch, runDir: rp.dir, planFile: rp.plan,
      cliEntry: CLI_ENTRY, orchestrationDoc: ORCHESTRATION_DOC, writableRoots,
    });
    const summary = {
      run_id: runId, session_id: sessionId, start_epoch: epoch, profile: CONTROLLER_PROFILE,
      writable_roots: writableRoots, codex_exe: run.config.codex_exe, args, dir,
    };
    if (c.values['dry-run']) {
      return {
        data: { ...summary, dry_run: true, prompt },
        text: [`dry run: controller ${sessionId} for run ${runId} (from epoch ${epoch})`,
          `writable: ${writableRoots.join('; ')}`, `command: ${run.config.codex_exe} ${args.join(' ')}`, '', prompt].join('\n'),
      };
    }

    const mode = launchMode(c.env);
    if (mode === 'none') throw usageError('controller start needs HYBRID_RUNNER_LAUNCH=wmi (default) or spawn');
    const keepaliveMs = Number(c.env.HYBRID_CONTROLLER_KEEPALIVE_MS) || CONTROLLER_KEEPALIVE_MS;
    // Marks the controller attached from now on, so the runner cannot idle out while the host starts.
    const starting = {
      schema: SCHEMAS.controller, run_id: runId, session_id: sessionId, start_epoch: epoch, dir, host: null,
      codex: null, thread_id: null, status: 'starting', started_at: nowIso(), heartbeat_at: nowIso(),
      keepalive_ms: keepaliveMs, ended_at: null, exit: null, stop_reason: null,
    };
    writeJsonAtomic(rp.controller, starting);
    const fail = (message, code = 'launch_failed', exitCode = 1) => {
      writeJsonAtomic(rp.controller, { ...starting, status: 'exited', ended_at: nowIso(), stop_reason: code });
      return new HybridError(message, exitCode, code);
    };
    try {
      await ensureRunner(c.home, runId, c.env);
    } catch (err) {
      throw fail(`The runner could not be started, so no controller was launched: ${err.message}`, err.code ?? 'error', err.exitCode ?? 1);
    }

    ensureDir(dir);
    const stdinFile = path.join(dir, 'prompt.md');
    writeFileExclusive(stdinFile, prompt);
    writeJsonAtomic(path.join(dir, 'launch.json'), {
      schema: SCHEMAS.controllerLaunch,
      home: c.home,
      run_id: runId,
      session_id: sessionId,
      start_epoch: epoch,
      requested_by: c.session,
      created_at: nowIso(),
      exe: run.config.codex_exe,
      args,
      cwd: rp.dir,
      writable_roots: writableRoots,
      stdin_file: stdinFile,
      stdout_file: path.join(dir, 'events.jsonl'),
      stderr_file: path.join(dir, 'stderr.txt'),
      last_message_file: lastMessageFile,
      keepalive_ms: keepaliveMs,
      runner_launch: mode,
    });
    let launched;
    try {
      launched = await launchNode(mode, [CONTROLLER_HOST_ENTRY, dir], dir);
    } catch (err) {
      throw fail(`Could not launch the controller host (${mode}): ${err.message}`);
    }

    const deadline = Date.now() + READY_TIMEOUT_MS;
    let record;
    for (;;) {
      record = readController(path.join(dir, 'controller.json'));
      if (record && record.status !== 'starting') break;
      if (Date.now() > deadline) {
        throw fail(`Controller host (pid ${launched.pid}) did not report within ${READY_TIMEOUT_MS / 1000}s; see ${dir}`);
      }
      await sleep(250);
    }
    // A controller that already finished (quickly) did start; only a spawn or host failure did not.
    if (['spawn_error', 'host_error'].includes(record.stop_reason)) {
      throw new HybridError(`Controller did not start: ${JSON.stringify(record.exit)}; see ${dir}`, 1, 'launch_failed');
    }
    return {
      data: { ...summary, host_pid: record.host?.pid ?? launched.pid, codex_pid: record.codex?.pid ?? null },
      text: [
        `controller ${sessionId} ${record.status === 'running' ? 'started' : `started and already ${record.status}`} for run ${runId} (host pid ${record.host?.pid ?? launched.pid}).`,
        `It will \`hybrid takeover\` (epoch ${epoch + 1}); your epoch ${epoch} is then fenced.`,
        `Writable roots: ${writableRoots.join('; ')}`,
        `Log: ${dir}. To return: re-ground from plan.md and \`hybrid status\`, then \`hybrid takeover\` `
          + '(this also stops the controller if it is still running).',
      ].join('\n'),
    };
  },
};
