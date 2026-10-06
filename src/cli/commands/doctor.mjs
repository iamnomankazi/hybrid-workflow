import fs from 'node:fs';
import path from 'node:path';
import { loadMachineConfig } from '../../config.mjs';
import { resolveCodexExe, codexVersion } from '../../codex.mjs';
import { resolveGitExe, gitVersion } from '../../git.mjs';
import { homePaths, defaultWorktreeRoot } from '../../paths.mjs';
import { ensureDir, randomHex } from '../../fsutil.mjs';
import { ownIdentity } from '../../proc.mjs';
import { readActiveRunLock } from '../../store.mjs';
import { runnerAlive } from '../../launcher.mjs';
import { requirePositionals } from '../util.mjs';

const MIN_NODE = [22, 12];

function nodeCheck() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return { ok, detail: `${process.version}${ok ? '' : ` (need >= ${MIN_NODE.join('.')})`}` };
}

function gitCheck(home) {
  const gitExe = resolveGitExe();
  const version = gitVersion({ gitExe, hooksDir: homePaths(home).emptyHooks });
  return { ok: true, detail: `${gitExe} (${version})` };
}

function codexCheck(machine) {
  const exe = resolveCodexExe(machine.codex_exe);
  const version = codexVersion({ exe, prefixArgs: machine.codex_prefix_args });
  return { ok: true, detail: `${exe} (${version})` };
}

function homeCheck(home) {
  ensureDir(home);
  const probe = path.join(home, `.probe-${randomHex(4)}`);
  fs.writeFileSync(probe, 'x');
  fs.rmSync(probe, { force: true });
  return { ok: true, detail: home };
}

// Creates the root (and any missing parents) to prove it is creatable, then removes only what it created.
function worktreeRootCheck(machine) {
  const root = path.resolve(machine.worktree_root ?? defaultWorktreeRoot());
  const created = [];
  for (let dir = root; !fs.existsSync(dir); dir = path.dirname(dir)) created.push(dir);
  try {
    fs.mkdirSync(root, { recursive: true });
    const probe = path.join(root, `.probe-${randomHex(4)}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
  } finally {
    for (const dir of created) {
      try { fs.rmdirSync(dir); } catch { /* not empty or already gone */ }
    }
  }
  return { ok: true, detail: root };
}

async function cimCheck() {
  const id = await ownIdentity();
  return { ok: true, detail: `pid ${id.pid} start ${id.start_time}` };
}

async function activeRunCheck(home) {
  const lock = readActiveRunLock(home);
  if (!lock?.run_id) return { ok: true, detail: 'none' };
  const { alive, lock: runnerLock } = await runnerAlive(home, lock.run_id);
  return { ok: true, detail: `${lock.run_id}, runner ${alive ? `alive (pid ${runnerLock.pid})` : 'not running'}` };
}

export const doctor = {
  usage: 'doctor',
  options: {},
  async run(c) {
    requirePositionals(c, 0);
    let machine = null;
    const checks = [];
    const check = async (name, fn) => {
      try {
        checks.push({ name, ...(await fn()) });
      } catch (err) {
        checks.push({ name, ok: false, detail: err.message.split('\n')[0] });
      }
    };
    await check('node', nodeCheck);
    await check('home', () => homeCheck(c.home));
    await check('config', () => {
      machine = loadMachineConfig(c.home);
      return { ok: true, detail: `${Object.keys(machine.repos).length} repo(s)` };
    });
    await check('git', () => gitCheck(c.home));
    await check('codex', () => codexCheck(machine ?? loadMachineConfig(c.home)));
    await check('worktree_root', () => worktreeRootCheck(machine ?? loadMachineConfig(c.home)));
    await check('powershell_cim', cimCheck);
    await check('active_run', () => activeRunCheck(c.home));
    const ok = checks.every((x) => x.ok);
    return {
      data: { ok, checks },
      text: checks.map((x) => `${x.ok ? 'ok  ' : 'FAIL'} ${x.name}: ${x.detail}`).join('\n'),
      exitCode: ok ? 0 : 1,
    };
  },
};
