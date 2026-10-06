import fs from 'node:fs';
import path from 'node:path';
import { TERMINAL_STATES } from '../../constants.mjs';
import { homePaths, jobPaths, worktreePath } from '../../paths.mjs';
import { nowIso, writeJsonAtomic } from '../../fsutil.mjs';
import * as git from '../../git.mjs';
import * as store from '../../store.mjs';
import { areAlive } from '../../proc.mjs';
import { requirePositionals, selectRun } from '../util.mjs';

const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

function isEligible(state, result, decision, allTerminal) {
  if (!TERMINAL_STATES.has(state.state)) return false;
  const finished = state.state === 'completed' || state.state === 'rejected' || decision || allTerminal;
  const captured = result?.patch?.captured === true || state.state === 'rejected';
  return !!(finished && captured);
}

export const gc = {
  usage: 'gc [--dry-run] [--all-terminal] [--epoch <n>]',
  options: { 'dry-run': { type: 'boolean' }, 'all-terminal': { type: 'boolean' }, epoch: { type: 'string' } },
  async run(c) {
    requirePositionals(c, 0);
    const { home, values } = c;
    const { runId, run } = selectRun(c);
    if (run.status === 'open') store.assertOwner(run, values.epoch);
    const dryRun = !!values['dry-run'];
    const ctx = { gitExe: run.tools.git_exe, hooksDir: homePaths(home).emptyHooks };
    const runRoot = path.join(path.resolve(run.config.worktree_root), runId);

    const candidates = [];
    for (const jobId of store.listJobIds(home, runId)) {
      const state = store.readJobState(home, runId, jobId);
      if (!state?.worktree || !exists(state.worktree)) continue;
      const result = TERMINAL_STATES.has(state.state) ? store.readJobResult(home, runId, jobId) : null;
      if (!isEligible(state, result, store.readDecision(home, runId, jobId), values['all-terminal'])) continue;
      candidates.push({ jobId, state });
    }

    const identities = candidates.flatMap(({ state }) => Object.values(state.process ?? {}));
    const aliveFlags = await areAlive(identities);
    let cursor = 0;
    const items = [];
    for (const { jobId, state } of candidates) {
      const own = Object.values(state.process ?? {});
      const alive = aliveFlags.slice(cursor, cursor + own.length).some(Boolean);
      cursor += own.length;
      const item = { job_id: jobId, state: state.state, worktree: state.worktree, action: dryRun ? 'would_remove' : 'removed', detail: null };
      const expected = worktreePath(run.config.worktree_root, runId, jobId);
      if (path.resolve(state.worktree).toLowerCase() !== path.resolve(expected).toLowerCase()) {
        Object.assign(item, { action: 'skipped', detail: `worktree is not at the expected location ${expected}` });
      } else if (alive) {
        Object.assign(item, { action: 'skipped', detail: 'a recorded process is still alive' });
      } else if (!dryRun) {
        const res = git.removeWorktree(ctx, { repo: run.repo.path, worktree: state.worktree });
        item.detail = res.detail;
        if (res.removed) {
          writeJsonAtomic(path.join(jobPaths(home, runId, jobId).dir, 'gc.json'), {
            removed_at: nowIso(), worktree: state.worktree, detail: res.detail,
          });
        } else {
          item.action = 'failed';
        }
      }
      items.push(item);
    }

    let runRootRemoved = false;
    if (!dryRun && run.status === 'closed' && exists(runRoot) && fs.readdirSync(runRoot).length === 0) {
      fs.rmdirSync(runRoot);
      runRootRemoved = true;
    }
    const lines = items.map((i) => `${i.action} ${i.job_id} ${i.worktree}${i.detail && i.detail !== 'removed' ? ` (${i.detail})` : ''}`);
    if (runRootRemoved) lines.push(`removed empty ${runRoot}`);
    return {
      data: { run_id: runId, dry_run: dryRun, items, run_root_removed: runRootRemoved },
      text: lines.length ? lines.join('\n') : 'nothing to remove',
    };
  },
};
