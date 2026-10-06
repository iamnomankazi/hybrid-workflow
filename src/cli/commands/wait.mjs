import { EXIT, WAKE_STATES } from '../../constants.mjs';
import { sleep } from '../../fsutil.mjs';
import * as store from '../../store.mjs';
import { runnerAlive } from '../../launcher.mjs';
import {
  parseDuration, parseSeq, readCursor, requirePositionals, selectRun, workSummary,
} from '../util.mjs';
import { formatChanges } from './status.mjs';

const LIVENESS_CHECK_MS = 30_000;

const isWake = (r) => r.kind === 'job' && WAKE_STATES.has(r.to);

export const wait = {
  usage: 'wait [--any] [--since <n>] [--timeout 50m] [--debounce 60s] [--poll 2s]',
  options: {
    any: { type: 'boolean' },
    since: { type: 'string' },
    timeout: { type: 'string' },
    debounce: { type: 'string' },
    poll: { type: 'string' },
  },
  async run(c) {
    requirePositionals(c, 0);
    const { home, values } = c;
    const { runId, run, rp } = selectRun(c);
    const timeoutMs = parseDuration(values.timeout ?? '50m', '--timeout');
    // --any: do not batch, report at the first wake transition.
    const debounceMs = values.any ? 0 : parseDuration(values.debounce ?? '60s', '--debounce');
    const pollMs = Math.max(50, parseDuration(values.poll ?? '2s', '--poll'));
    const since = values.since !== undefined
      ? parseSeq(values.since, '--since')
      : (readCursor(rp, c.session) ?? store.lastTransitionSeq(home, runId));

    const deadline = Date.now() + timeoutMs;
    const records = [];
    let cursor = since;
    let offset = 0;
    let firstWake = null;
    let lastLiveness = -Infinity;

    const finish = (reason, exitCode = EXIT.ok, extra = {}) => {
      const lines = [`wait: ${reason}`, `cursor: ${cursor}`, ...formatChanges(records)];
      if (extra.hint) lines.push(`hint: ${extra.hint}`);
      return { data: { run_id: runId, reason, cursor, records, ...extra }, text: lines.join('\n'), exitCode };
    };

    for (;;) {
      const next = store.readTransitions(home, runId, { sinceSeq: since, offset });
      offset = next.nextOffset;
      for (const r of next.records) {
        records.push(r);
        cursor = Math.max(cursor, r.seq);
      }
      const now = Date.now();
      if (firstWake === null && records.some(isWake)) firstWake = now;

      const work = workSummary(home, runId);
      if (firstWake !== null) {
        // Nothing left to batch with once no work remains: report without sitting out the debounce.
        if (!work.busy || now - firstWake >= debounceMs || now >= deadline) return finish('woke');
      } else {
        if (!work.busy) return finish('idle');
        if (now - lastLiveness >= LIVENESS_CHECK_MS) {
          lastLiveness = now;
          if (!(await runnerAlive(home, runId)).alive) {
            return finish('runner_down', EXIT.ok, { hint: `hybrid run ensure-runner --epoch ${run.owner.epoch}` });
          }
        }
        if (now >= deadline) return finish('timeout', EXIT.waitTimeout);
      }
      const wakeAt = firstWake === null ? Infinity : firstWake + debounceMs;
      await sleep(Math.max(0, Math.min(pollMs, deadline - Date.now(), wakeAt - Date.now())));
    }
  },
};
