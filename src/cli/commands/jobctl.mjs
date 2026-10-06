// Owner commands that act on one job: cancel, resume, decide.
import { ACTIVE_STATES, DECISIONS, RESUMABLE_STATES, SCHEMAS, TERMINAL_STATES } from '../../constants.mjs';
import { nowIso, readText, withMutex, writeJsonAtomic } from '../../fsutil.mjs';
import { MAX_NOTE_BYTES } from '../../spec.mjs';
import * as store from '../../store.mjs';
import {
  awaitOutcome, conflictError, notFoundError, outcomeResult, requireJob, requirePositionals, selectOwnedRun,
  startRunner, usageError,
} from '../util.mjs';

export const cancel = {
  usage: 'cancel <job> --epoch <n>',
  options: { epoch: { type: 'string' } },
  async run(c) {
    requirePositionals(c, 1);
    const { runId, epoch } = selectOwnedRun(c);
    const jobId = c.positionals[0];
    const { state } = requireJob(c.home, runId, jobId);
    const name = state?.state ?? 'pending';
    if (state && state.state !== 'queued' && !ACTIVE_STATES.has(state.state)) {
      throw conflictError(`Job ${jobId} is ${name}; only pending, queued or active jobs can be cancelled`);
    }
    const request = store.writeRequest(c.home, runId, { type: 'cancel', epoch, session_id: c.session, job_id: jobId });
    await startRunner(c.home, runId, `Cancel request ${request.id} queued`);
    return outcomeResult(`cancel ${jobId}`, request, await awaitOutcome(c.home, runId, request.id));
  },
};

function readNote(values) {
  if (values.note !== undefined && values['note-file'] !== undefined) {
    throw usageError('Use either --note or --note-file, not both');
  }
  let note = values.note ?? null;
  if (values['note-file'] !== undefined) {
    try {
      note = readText(values['note-file']);
    } catch (err) {
      throw notFoundError(`Cannot read --note-file: ${err.message}`);
    }
  }
  if (note !== null && Buffer.byteLength(note, 'utf8') > MAX_NOTE_BYTES) {
    throw usageError(`Resume note exceeds ${MAX_NOTE_BYTES} bytes`);
  }
  return note;
}

export const resume = {
  usage: 'resume <job> --epoch <n> [--note <text> | --note-file <file>]',
  options: { epoch: { type: 'string' }, note: { type: 'string' }, 'note-file': { type: 'string' } },
  async run(c) {
    requirePositionals(c, 1);
    const { runId, epoch } = selectOwnedRun(c);
    const jobId = c.positionals[0];
    const { state } = requireJob(c.home, runId, jobId);
    const note = readNote(c.values);
    if (!state || !RESUMABLE_STATES.has(state.state)) {
      throw conflictError(
        `Job ${jobId} is ${state?.state ?? 'pending'}; resume needs one of: ${[...RESUMABLE_STATES].join(', ')}`,
      );
    }
    if (!state.codex_session_id) {
      throw conflictError(`Job ${jobId} never recorded a Codex session, so it cannot be resumed; submit a fresh job instead`);
    }
    const request = store.writeRequest(c.home, runId, {
      type: 'resume', epoch, session_id: c.session, job_id: jobId, payload: { note },
    });
    await startRunner(c.home, runId, `Resume request ${request.id} queued`);
    return outcomeResult(`resume ${jobId}`, request, await awaitOutcome(c.home, runId, request.id));
  },
};

export const decide = {
  usage: `decide <job> <${DECISIONS.join('|')}> --epoch <n> [--note <text>]`,
  options: { epoch: { type: 'string' }, note: { type: 'string' } },
  run(c) {
    requirePositionals(c, 2);
    const { runId, rp } = selectOwnedRun(c);
    const [jobId, decision] = c.positionals;
    if (!DECISIONS.includes(decision)) throw usageError(`Decision must be one of: ${DECISIONS.join(', ')}`);
    const { jp, state } = requireJob(c.home, runId, jobId);
    if (!state || !TERMINAL_STATES.has(state.state)) {
      throw conflictError(`Job ${jobId} is ${state?.state ?? 'pending'}; only terminal jobs can be decided`);
    }
    const doc = withMutex(rp.runMutex, () => {
      const epoch = store.assertOwner(store.loadRun(c.home, runId), c.values.epoch);
      const prev = store.readDecision(c.home, runId, jobId);
      const next = {
        schema: SCHEMAS.decision,
        job_id: jobId,
        decision,
        note: c.values.note ?? null,
        epoch,
        session_id: c.session,
        decided_at: nowIso(),
        history: prev
          ? [...(prev.history ?? []), {
            decision: prev.decision, note: prev.note, epoch: prev.epoch, session_id: prev.session_id, decided_at: prev.decided_at,
          }]
          : [],
      };
      writeJsonAtomic(jp.decision, next);
      return next;
    });
    return { data: doc, text: `${jobId}: decided ${decision}${doc.note ? ` (${doc.note})` : ''}` };
  },
};
