// Temporary Sol controller: a trusted top-level Codex session that takes over a run from Opus
// through the normal epoch takeover and drives it with the same CLI, plan.md and git worktree.
// It is not a worker. It gets a fixed profile (docs/ORCHESTRATION.md "Controller handoff"): a
// workspace-write sandbox limited to the run directory, the repository's git directory and any
// explicitly named integration worktrees. The controller host (src/runner/controller-host.mjs)
// runs as the user and keeps the runner alive, since the sandbox account cannot launch it
// (WMI Win32_Process.Create is denied to CodexSandboxOnline).
import fs from 'node:fs';
import path from 'node:path';
import { BASE_SHELL_ENV, WORKER_DISABLED_FEATURES, assertSafeArgs } from './codex.mjs';
import { readJson } from './fsutil.mjs';

export const CONTROLLER_PROFILE = Object.freeze({
  model: 'gpt-6.1-sol',
  effort: 'xhigh',
  sandbox: 'workspace-write',
  windowsSandbox: 'elevated',
});

// The host refreshes controller.json this often; the runner treats the controller as gone
// (and may idle out) once the heartbeat is older than CONTROLLER_STALE_FACTOR intervals, and never
// sooner than CONTROLLER_STALE_MIN_MS (covers the gap between `controller start` and the host's first beat).
export const CONTROLLER_KEEPALIVE_MS = 30_000;
export const CONTROLLER_STALE_FACTOR = 4;
export const CONTROLLER_STALE_MIN_MS = 60_000;

const tomlLiteral = (s) => {
  if (typeof s !== 'string' || /['\r\n]/.test(s)) throw new Error(`Invalid value: ${s}`);
  return `'${s}'`;
};

// Git refuses repositories owned by another account ("dubious ownership"), and the controller's
// shell runs as the sandbox account. safe.directory goes through git's environment config for the
// controller's shell only; global git config is never touched. A trailing /* trusts everything
// below the root (git >= 2.46).
export function controllerShellEnv({ home, sessionId, safeDirectories }) {
  const gitConfig = [
    [BASE_SHELL_ENV.GIT_CONFIG_KEY_0, BASE_SHELL_ENV.GIT_CONFIG_VALUE_0],
    ...safeDirectories.flatMap((dir) => {
      const d = dir.replace(/\\/g, '/').replace(/\/+$/, '');
      return [['safe.directory', d], ['safe.directory', `${d}/*`]];
    }),
  ];
  const env = {
    PSExecutionPolicyPreference: BASE_SHELL_ENV.PSExecutionPolicyPreference,
    HYBRID_HOME: home,
    HYBRID_SESSION_ID: sessionId,
    // The host owns runner launches; the sandbox account's WMI launch would fail anyway.
    HYBRID_RUNNER_LAUNCH: 'none',
    GIT_CONFIG_COUNT: String(gitConfig.length),
  };
  gitConfig.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

// Same hardening as workers (no user config/rules, account connectors and plugins off, skills
// catalog off) with the controller's own model, effort and writable roots. The shell inherits
// the host's environment (Codex's default policy, which drops *KEY*/*SECRET*/*TOKEN* names).
export function buildControllerArgs({ cwd, writableRoots, lastMessageFile, shellEnv }) {
  const { model, effort, sandbox, windowsSandbox } = CONTROLLER_PROFILE;
  for (const [name, value] of [['cwd', cwd], ['lastMessageFile', lastMessageFile]]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`Invalid ${name}: ${value}`);
  }
  if (!Array.isArray(writableRoots)) throw new Error('writableRoots must be an array');
  const args = [
    'exec', '--ignore-user-config', '--strict-config', '--ignore-rules', '--skip-git-repo-check',
    '-m', model,
    '-c', `model_reasoning_effort="${effort}"`,
    '-s', sandbox,
    '-c', 'approval_policy="never"',
    '-c', `windows.sandbox="${windowsSandbox}"`,
    '-c', 'sandbox_workspace_write.network_access=true',
    ...(writableRoots.length
      ? ['-c', `sandbox_workspace_write.writable_roots=[${writableRoots.map(tomlLiteral).join(', ')}]`]
      : []),
    ...Object.entries(shellEnv).flatMap(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid shell variable name: ${name}`);
      return ['-c', `shell_environment_policy.set.${name}=${tomlLiteral(value)}`];
    }),
    '-c', 'skills.include_instructions=false',
    ...WORKER_DISABLED_FEATURES.flatMap((f) => ['-c', `features.${f}=false`]),
    '-C', cwd,
    '--json', '-o', lastMessageFile,
    '-',
  ];
  assertSafeArgs(args);
  if (args[args.indexOf('-s') + 1] !== 'workspace-write') throw new Error('Controller sandbox must be workspace-write');
  return args;
}

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const isSameOrAncestor = (ancestor, p) => {
  const a = norm(ancestor);
  const b = norm(p);
  return b === a || b.startsWith(`${a}\\`);
};

// Extra writable roots (integration worktrees outside the run directory) must be narrow: never a
// drive root, the user profile or anything containing it, a directory containing the repository
// or the Hybrid home (which would also cover unrelated projects and runs), or the repository's
// own checkout (main's working tree stays read-only to the controller).
export function validateExtraRoot(dir, { repo, home, userProfile }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return `must be an absolute path: ${dir}`;
  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch { /* reported below */ }
  if (!stat?.isDirectory()) return `not an existing directory: ${dir}`;
  const resolved = path.resolve(dir);
  if (norm(path.parse(resolved).root) === norm(resolved)) return `is a drive root: ${dir}`;
  if (userProfile && isSameOrAncestor(resolved, userProfile)) return `is or contains the user profile: ${dir}`;
  if (isSameOrAncestor(resolved, repo)) return `is or contains the repository ${repo}: ${dir}`;
  if (isSameOrAncestor(resolved, home)) return `is or contains the Hybrid home ${home}: ${dir}`;
  return null;
}

// Facts only; the procedure lives in ORCHESTRATION.md so both controllers follow one contract.
export function controllerPrompt({
  runId, home, sessionId, startEpoch, runDir, planFile, cliEntry, orchestrationDoc, writableRoots,
}) {
  return `You are taking over as the controller of Hybrid Workflow run ${runId}. You are a trusted
top-level controller session, not a Hybrid worker. You have no access to the previous
controller's conversation; everything you need is on disk.

Facts:
- Hybrid CLI: node "${cliEntry}" <command>   (written \`hybrid\` below)
- Your shell already has HYBRID_HOME=${home}, HYBRID_SESSION_ID=${sessionId} and
  HYBRID_RUNNER_LAUNCH=none. Keep them.
- Run directory: ${runDir}
- plan.md: ${planFile}
- The run's owner epoch when you were launched: ${startEpoch}. \`hybrid takeover\` gives you the next one.
- Writable roots (everything else is read-only to you): ${writableRoots.join('; ')}
- A controller host running as the user keeps the Hybrid runner alive while you work. Never
  launch the runner, Codex or any other AI CLI yourself.

Do this:
1. Read ${orchestrationDoc} and follow it as your contract. Where it says "Opus", read "the
   controlling session", i.e. you. Its "Controller handoff" section applies to you directly.
   docs/CLI.md next to it documents every command.
2. Read plan.md, then inspect the run with \`hybrid status --json\` and \`hybrid result <job>\`.
3. Run \`hybrid takeover --json\` (it takes no --epoch) and use the returned epoch on every
   mutating command. If any command exits 3 (fenced), another controller has taken over: stop
   at once without further changes.
4. Continue plan.md's remaining work exactly as the contract describes. Keep plan.md current at
   every wake, before acting.
5. Stop when the planned work is done or needs a human decision, and only at a clean boundary
   (as the contract defines it), with plan.md updated for the next controller. Human-only: merge
   to main, push, close the run, change the goal.

Filesystem rules:
- Inside your writable roots do normal development work freely: create, edit, move and delete
  files, git operations, test and temp cleanup, recursive removal of generated directories when
  genuinely needed.
- Never intentionally modify or recursively delete anything outside them. Never target a drive
  root, user profile, Windows/system directory, unrelated project or a parent directory holding
  unrelated data. Before recursively deleting a directory, resolve the path and confirm it is
  inside a writable root. Do not clean up for its own sake.
- Do not try to weaken, disable or bypass the sandbox. If an operation is rejected, do not work
  around it: record the exact command, error and path in plan.md, and continue with what you can
  or stop at a clean boundary.

End with a short report: the state you found, what you did, the epoch you held, and where you
stopped.
`;
}

function readLoose(file) {
  try {
    return readJson(file, { optional: true });
  } catch {
    return null;
  }
}

export function readController(file) {
  return readLoose(file);
}

// True while a controller is starting or running with a fresh heartbeat. Cheap and synchronous
// (no process query), so the runner can call it from its idle check.
export function controllerAttached(record, nowMs = Date.now()) {
  if (!record || !['starting', 'running'].includes(record.status)) return false;
  const beat = Date.parse(record.heartbeat_at ?? '');
  const interval = Number(record.keepalive_ms) || CONTROLLER_KEEPALIVE_MS;
  return Number.isFinite(beat) && nowMs - beat < Math.max(interval * CONTROLLER_STALE_FACTOR, CONTROLLER_STALE_MIN_MS);
}
