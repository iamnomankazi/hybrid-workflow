import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../../constants.mjs';
import { homePaths, jobPaths } from '../../paths.mjs';
import { validateSpec } from '../../spec.mjs';
import * as git from '../../git.mjs';
import { nowIso, readJson, readText, sha256, writeFileExclusive } from '../../fsutil.mjs';
import * as store from '../../store.mjs';
import { HybridError } from '../../store.mjs';
import {
  awaitOutcome, conflictError, nextJobId, notFoundError, outcomeResult, requirePositionals, selectOwnedRun,
  startRunner, usageError,
} from '../util.mjs';

const GENERATED_ID_RETRIES = 20;

function readSpecFile(specPath) {
  try {
    return readJson(specPath);
  } catch (err) {
    if (err.code === 'ENOENT') throw notFoundError(`Spec file not found: ${specPath}`);
    throw usageError(err.message);
  }
}

// Capsule text from the inline field or the file next to the spec; read problems are added to errors.
function loadCapsule(raw, specPath, errors) {
  if (typeof raw?.capsule === 'string') return raw.capsule;
  if (typeof raw?.capsule_file !== 'string') return undefined;
  const file = path.resolve(path.dirname(specPath), raw.capsule_file);
  try {
    return readText(file);
  } catch {
    errors.push(`capsule_file not readable: ${file}`);
    return undefined;
  }
}

// mkdir is deliberately non-recursive: EEXIST is the id-collision signal.
function createJobDir(home, runId, requestedId) {
  if (requestedId) {
    const jp = jobPaths(home, runId, requestedId);
    try {
      fs.mkdirSync(jp.dir);
    } catch (err) {
      if (err.code === 'EEXIST') throw conflictError(`Job id already exists in run ${runId}: ${requestedId}`);
      throw err;
    }
    return { jobId: requestedId, jp };
  }
  for (let skip = 0; skip < GENERATED_ID_RETRIES; skip++) {
    const jobId = nextJobId(store.listJobIds(home, runId), skip);
    const jp = jobPaths(home, runId, jobId);
    try {
      fs.mkdirSync(jp.dir);
      return { jobId, jp };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new HybridError('Could not allocate a job id', EXIT.error, 'job_id');
}

export const submit = {
  usage: 'submit <spec.json> --epoch <n> [--no-wait]',
  options: { epoch: { type: 'string' }, 'no-wait': { type: 'boolean' } },
  async run(c) {
    requirePositionals(c, 1);
    const { home } = c;
    const { runId, run, epoch } = selectOwnedRun(c);
    const specPath = path.resolve(c.positionals[0]);
    const raw = readSpecFile(specPath);

    const errors = [];
    const capsuleText = loadCapsule(raw, specPath, errors);
    const validation = validateSpec(raw, {
      presets: run.config.presets,
      defaultTimeoutMinutes: run.config.default_timeout_minutes,
      maxTimeoutMinutes: run.config.max_timeout_minutes,
      defaultStallMinutes: run.config.stall_minutes,
      capsuleText,
    });
    errors.push(...validation.errors);
    if (validation.ok && validation.spec.base_commit) {
      const ctx = { gitExe: run.tools.git_exe, hooksDir: homePaths(home).emptyHooks };
      if (!git.commitExists(ctx, run.repo.path, validation.spec.base_commit)) {
        errors.push(`base_commit ${validation.spec.base_commit} does not exist in ${run.repo.path}`);
      }
    }
    if (errors.length) throw usageError(`Invalid spec:\n${errors.map((e) => `- ${e}`).join('\n')}`);

    const { jobId, jp } = createJobDir(home, runId, validation.spec.job_id);
    let request;
    try {
      const capsuleBytes = Buffer.from(capsuleText, 'utf8');
      writeFileExclusive(jp.capsule, capsuleBytes);
      writeFileExclusive(jp.spec, JSON.stringify({
        ...validation.spec,
        job_id: jobId,
        run_id: runId,
        capsule_sha256: sha256(capsuleBytes),
        submitted_at: nowIso(),
        submitted_epoch: epoch,
        submitted_by: c.session,
      }, null, 2) + '\n');
      request = store.writeRequest(home, runId, { type: 'submit', epoch, session_id: c.session, job_id: jobId });
    } catch (err) {
      // Nothing was queued: leave no half-submitted job behind to block `run close`.
      fs.rmSync(jp.dir, { recursive: true, force: true });
      throw err;
    }

    const runner = await startRunner(home, runId, `Job ${jobId} submitted (request ${request.id})`);
    if (c.values['no-wait']) {
      return {
        data: { job_id: jobId, request_id: request.id, outcome: 'pending', runner_pid: runner.pid },
        text: `${jobId}: submitted (pending)`,
      };
    }
    const result = outcomeResult(`${jobId}`, request, await awaitOutcome(home, runId, request.id));
    result.data.job_id = jobId;
    return result;
  },
};
