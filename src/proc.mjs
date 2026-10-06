// Process identity, liveness, tree kill and orphan sweep.
// A process is (pid, start_time); start_time is CIM Win32_Process.CreationDate rendered by
// PowerShell as ToUniversalTime().ToString('o'). Every start_time in the system comes from the
// same expression below, so identity comparison is exact string equality. PID alone is never
// trusted: Windows reuses PIDs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep } from './fsutil.mjs';

const execFileAsync = promisify(execFile);

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
export const POWERSHELL_EXE = `${SYSTEM_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
export const TASKKILL_EXE = `${SYSTEM_ROOT}\\System32\\taskkill.exe`;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const STDERR_LIMIT = 2048;
const MIN_NEEDLE_LENGTH = 8;
const KILL_CONFIRM_MS = 3000;
const KILL_POLL_MS = 150;
const TASKKILL_NOT_FOUND = 128;

const PS_PREAMBLE = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);";

// Projects Win32_Process CIM instances (piped in) to the record shape used everywhere.
const PS_PROJECT = "ForEach-Object { [pscustomobject]@{ "
  + 'pid = [int]$_.ProcessId; '
  + 'ppid = [int]$_.ParentProcessId; '
  + 'name = $_.Name; '
  + 'exe = $_.ExecutablePath; '
  + "start_time = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }); "
  + 'command_line = $_.CommandLine } }';

function psFailure(err) {
  const stderr = String(err.stderr ?? '').trim().slice(0, STDERR_LIMIT);
  const reason = err.killed ? `timed out after ${err.timeout ?? '?'} ms` : (err.message ?? String(err));
  return new Error(`PowerShell failed (${reason})${stderr ? `: ${stderr}` : ''}`, { cause: err });
}

// Runs a constant script. All dynamic data must travel in `env` (HYBRID_PS_*), never in the script.
export async function runPowerShell(script, env = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const pending = execFileAsync(
    POWERSHELL_EXE,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
  pending.child.stdin?.end();
  try {
    const { stdout } = await pending;
    return stdout;
  } catch (err) {
    throw psFailure(err);
  }
}

// PowerShell emits nothing, one object or an array depending on result count; always return an array.
export function parseJsonOutput(stdout) {
  const text = String(stdout ?? '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`Unparsable PowerShell output (${err.message}): ${text.slice(0, STDERR_LIMIT)}`);
  }
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function toRecord(raw) {
  return {
    pid: Number(raw.pid),
    ppid: Number(raw.ppid),
    name: raw.name ?? null,
    exe: raw.exe ?? null,
    start_time: raw.start_time ?? null,
    command_line: raw.command_line ?? null,
  };
}

function assertPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid pid: ${String(pid)}`);
}

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

const QUERY_SCRIPT = `${PS_PREAMBLE} `
  + "$ids = @($env:HYBRID_PS_PIDS -split ',' | ForEach-Object { [int]$_ }); "
  + "$filter = ($ids | ForEach-Object { 'ProcessId=' + $_ }) -join ' OR '; "
  + `$items = @(Get-CimInstance Win32_Process -Filter $filter | ${PS_PROJECT}); `
  + 'ConvertTo-Json -InputObject $items -Compress -Depth 4';

export async function queryProcesses(pids) {
  const unique = [...new Set(pids)];
  const result = new Map();
  if (unique.length === 0) return result;
  for (const pid of unique) assertPid(pid);
  const stdout = await runPowerShell(QUERY_SCRIPT, { HYBRID_PS_PIDS: unique.join(',') });
  for (const raw of parseJsonOutput(stdout)) {
    const record = toRecord(raw);
    result.set(record.pid, record);
  }
  return result;
}

export async function getIdentity(pid) {
  assertPid(pid);
  const record = (await queryProcesses([pid])).get(pid);
  if (!record || !record.start_time) return null;
  return { pid: record.pid, start_time: record.start_time };
}

export async function ownIdentity() {
  const identity = await getIdentity(process.pid);
  if (!identity) throw new Error('Could not determine the identity of the current process');
  return identity;
}

function identityUsable(identity) {
  return !!identity && validPid(identity.pid)
    && typeof identity.start_time === 'string' && identity.start_time !== '';
}

// Cheap negative check: ESRCH means no such process, so the CIM query can be skipped.
function definitelyGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

export async function areAlive(identities) {
  const out = identities.map(() => false);
  const candidates = [];
  identities.forEach((identity, i) => {
    if (identityUsable(identity) && !definitelyGone(identity.pid)) candidates.push(i);
  });
  if (candidates.length === 0) return out;
  const records = await queryProcesses(candidates.map((i) => identities[i].pid));
  for (const i of candidates) {
    out[i] = records.get(identities[i].pid)?.start_time === identities[i].start_time;
  }
  return out;
}

export async function isAlive(identity) {
  return (await areAlive([identity]))[0];
}

// With a known start_time the pid must be absent or reused; without one, absent.
async function isGone(identity) {
  if (definitelyGone(identity.pid)) return true;
  const record = (await queryProcesses([identity.pid])).get(identity.pid);
  if (!record) return true;
  return typeof identity.start_time === 'string' && record.start_time !== identity.start_time;
}

export async function killTree(identity, { verify = true } = {}) {
  const result = {
    attempted: false, killed: false, already_gone: false, identity_mismatch: false, output: '',
  };
  assertPid(identity?.pid);
  if (identity.pid === process.pid) throw new Error('Refusing to kill the current process');
  if (verify) {
    const current = (await queryProcesses([identity.pid])).get(identity.pid);
    if (!current) {
      result.already_gone = true;
      return result;
    }
    if (current.start_time !== identity.start_time) {
      result.identity_mismatch = true;
      return result;
    }
  }
  result.attempted = true;
  try {
    const { stdout, stderr } = await execFileAsync(
      TASKKILL_EXE,
      ['/PID', String(identity.pid), '/T', '/F'],
      { windowsHide: true, timeout: DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
    );
    result.output = `${stdout}${stderr}`.trim();
  } catch (err) {
    if (typeof err.code !== 'number') throw err; // spawn failure or timeout, not a taskkill verdict
    result.output = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    if (err.code === TASKKILL_NOT_FOUND) {
      result.already_gone = true;
      return result;
    }
  }
  const deadline = Date.now() + KILL_CONFIRM_MS;
  for (;;) {
    if (await isGone(identity)) {
      result.killed = true;
      return result;
    }
    if (Date.now() >= deadline) return result;
    await sleep(KILL_POLL_MS);
  }
}

function checkNeedle(needle) {
  if (typeof needle !== 'string' || needle.length < MIN_NEEDLE_LENGTH) {
    throw new Error(`Needle must be at least ${MIN_NEEDLE_LENGTH} characters; sweeping on a short needle is unsafe`);
  }
}

const FIND_SCRIPT = `${PS_PREAMBLE} `
  + '$needle = $env:HYBRID_PS_NEEDLE; '
  + "$skip = @($PID) + @($env:HYBRID_PS_EXCLUDE -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ }); "
  + '$items = @(Get-CimInstance Win32_Process | Where-Object { '
  + '($skip -notcontains [int]$_.ProcessId) -and ('
  + '(($null -ne $_.CommandLine) -and ($_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0)) -or '
  + '(($null -ne $_.ExecutablePath) -and ($_.ExecutablePath.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0))) } '
  + `| ${PS_PROJECT}); `
  + 'ConvertTo-Json -InputObject $items -Compress -Depth 4';

export async function findProcessesReferencing(needle, { excludePids = [] } = {}) {
  checkNeedle(needle);
  for (const pid of excludePids) assertPid(pid);
  const exclude = [...new Set([process.pid, ...excludePids])];
  const stdout = await runPowerShell(FIND_SCRIPT, {
    HYBRID_PS_NEEDLE: needle,
    HYBRID_PS_EXCLUDE: exclude.join(','),
  });
  return parseJsonOutput(stdout).map(toRecord);
}

// The needle is a path, so a match must end at a path boundary: sweeping worktree ...\j1 must
// never kill the workers of ...\j10.
function referencesPath(record, needle) {
  const boundary = new RegExp(`${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_.-])`, 'i');
  return boundary.test(record.command_line ?? '') || boundary.test(record.exe ?? '');
}

// Records whose start_time is unknown cannot be identity-verified and are reported as failed
// rather than killed by bare PID.
export async function sweepOrphans(needle, { excludePids = [] } = {}) {
  const found = (await findProcessesReferencing(needle, { excludePids })).filter((r) => referencesPath(r, needle));
  const killed = [];
  const failed = [];
  for (const record of found) {
    const identity = { pid: record.pid, start_time: record.start_time };
    if (!record.start_time) {
      failed.push({ identity, reason: 'no_start_time' });
      continue;
    }
    try {
      const r = await killTree(identity, { verify: true });
      if (r.killed) killed.push(identity);
      else if (r.attempted) failed.push({ identity, reason: r.output || 'still_alive_after_kill' });
      // already_gone / identity_mismatch: the target no longer exists; nothing to do.
    } catch (err) {
      failed.push({ identity, reason: err.message });
    }
  }
  return { found, killed, failed };
}

const BOOT_SCRIPT = `${PS_PREAMBLE} `
  + "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')";

export async function getBootTime() {
  const text = (await runPowerShell(BOOT_SCRIPT)).trim();
  if (!text) throw new Error('PowerShell returned no boot time');
  return text;
}
