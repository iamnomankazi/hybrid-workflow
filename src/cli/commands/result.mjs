import path from 'node:path';
import { TERMINAL_STATES } from '../../constants.mjs';
import { truncateUtf8 } from '../../fsutil.mjs';
import * as store from '../../store.mjs';
import { requireJob, requirePositionals, selectRun, truncate } from '../util.mjs';

const MAX_FILES = 50;
const MAX_RAW_BYTES = 16 * 1024;
const FIELD_CAP = 4000;

const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

function reportLines(wr, full) {
  if (!wr?.present) return ['worker: no report'];
  const r = wr.report;
  const lines = [`worker: ${r ? `status=${r.status} ` : ''}valid_json=${wr.valid_json} job_id_matches=${wr.job_id_matches}`];
  if (r) {
    for (const key of ['summary', 'tests', 'notes']) {
      if (r[key] !== undefined && r[key] !== '') lines.push(`  ${key}: ${full ? asText(r[key]) : truncate(asText(r[key]), FIELD_CAP)}`);
    }
  }
  if (full && wr.raw) {
    const raw = truncateUtf8(wr.raw, MAX_RAW_BYTES);
    lines.push('  raw:', raw.text);
    if (raw.truncated || wr.truncated) lines.push('  (raw truncated)');
  }
  return lines;
}

function patchLines(patch, patchFile, full) {
  if (!patch) return [];
  const s = patch.stats ?? {};
  const lines = [`patch: ${patch.verdict}${patch.captured ? ` ${s.files ?? 0} files +${s.added ?? 0}/-${s.deleted ?? 0}` : ' (not captured)'}`];
  if (patch.error) lines.push(`  error: ${patch.error}`);
  if (patchFile) lines.push(`  file: ${patchFile}`);
  for (const v of patch.violations ?? []) lines.push(`  violation: ${v.rule ?? '?'} ${v.path ?? ''} ${v.detail ?? ''}`.trimEnd());
  const files = patch.files ?? [];
  for (const f of full ? files : files.slice(0, MAX_FILES)) {
    lines.push(`  ${f.status} ${f.path}${f.binary ? ' (binary)' : ` +${f.added}/-${f.deleted}`}`);
  }
  if (!full && files.length > MAX_FILES) lines.push(`  ... ${files.length - MAX_FILES} more file(s) (use --full)`);
  return lines;
}

function provenanceLines(p) {
  if (!p) return [];
  const lines = [];
  if (p.requested) lines.push(`requested: ${p.requested.model} ${p.requested.effort} ${p.requested.sandbox} approval=${p.requested.approval_policy}`);
  if (p.observed) {
    const o = p.observed;
    lines.push(`observed: ${o.model} ${o.effort} ${o.sandbox_policy} approval=${o.approval_policy}${p.observed_matches ? '' : ' MISMATCH'}`);
  }
  if (p.observed_mismatches?.length) lines.push(`  mismatches: ${p.observed_mismatches.map(asText).join('; ')}`);
  if (p.codex_session_id) lines.push(`codex_session: ${p.codex_session_id}`);
  lines.push(`versions: codex=${p.codex_version ?? '-'} runner=${p.runner_version ?? '-'} node=${p.node_version ?? '-'}`);
  return lines;
}

export const result = {
  usage: 'result <job> [--full]',
  options: { full: { type: 'boolean' } },
  run(c) {
    requirePositionals(c, 1);
    const { runId } = selectRun(c);
    const jobId = c.positionals[0];
    const { jp, state } = requireJob(c.home, runId, jobId);
    const stateName = state?.state ?? 'pending';
    if (!state || !TERMINAL_STATES.has(state.state)) {
      return {
        data: { job_id: jobId, state: stateName, terminal: false },
        text: `job ${jobId}: ${stateName} (not terminal)`,
      };
    }
    const res = store.readJobResult(c.home, runId, jobId);
    const decision = store.readDecision(c.home, runId, jobId);
    if (!res) {
      // The runner writes result.json before state.json; absence means a runner bug or manual tampering.
      return { data: { job_id: jobId, state: stateName, terminal: true, result: null }, text: `job ${jobId}: ${stateName} (result.json missing)` };
    }
    const full = !!c.values.full;
    const patchFile = res.patch?.file ? path.join(jp.dir, res.patch.file) : null;
    const t = res.timestamps ?? {};
    const lines = [
      `job: ${jobId} ${res.state}${res.reason ? ` (${res.reason})` : ''}`,
      ...(res.detail ? [`detail: ${res.detail}`] : []),
      `attempt: ${res.attempt}`,
      `exit: code=${res.exit?.code ?? '-'} signal=${res.exit?.signal ?? '-'} source=${res.exit?.source ?? '-'}`,
      ...reportLines(res.worker_report, full),
      ...patchLines(res.patch, patchFile, full),
      ...provenanceLines(res.provenance),
      `times: queued=${t.queued_at ?? '-'} started=${t.started_at ?? '-'} ended=${t.ended_at ?? '-'}`,
      ...(decision ? [`decision: ${decision.decision}${decision.note ? ` - ${decision.note}` : ''}`] : []),
    ];
    return {
      data: { ...res, decision: decision ?? null, patch_path: patchFile },
      text: lines.join('\n'),
    };
  },
};
