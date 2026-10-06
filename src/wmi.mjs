// Headless launcher: Win32_Process.Create via WMI. The child is parented by WmiPrvSE rather
// than by us, which is what lets it survive Claude Desktop quitting (docs/ARCHITECTURE.md s2).
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './fsutil.mjs';
import { runPowerShell, parseJsonOutput } from './proc.mjs';

const MAX_COMMAND_LINE = 32000;

// CreateFlags 0x8 = DETACHED_PROCESS, ShowWindow 0 = SW_HIDE. CREATE_NO_WINDOW is rejected by
// WMI with 21 and CREATE_NEW_CONSOLE would flash a window, so neither is used.
const LAUNCH_SCRIPT = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); "
  + '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ CreateFlags = [uint32]0x00000008; ShowWindow = [uint16]0 }; '
  + '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:HYBRID_PS_CMDLINE; CurrentDirectory = $env:HYBRID_PS_CWD; ProcessStartupInformation = $startup }; '
  + "$out = [ordered]@{ return_value = [int]$r.ReturnValue; pid = $null; start_time = $null }; "
  + 'if ($r.ReturnValue -eq 0) { '
  + "$out.pid = [int]$r.ProcessId; "
  + "$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$r.ProcessId); "
  + "if ($p -and $p.CreationDate) { $out.start_time = $p.CreationDate.ToUniversalTime().ToString('o') } "
  + '}; '
  + 'ConvertTo-Json -InputObject $out -Compress -Depth 4';

const RETURN_VALUE_NAMES = Object.freeze({
  2: 'access denied',
  3: 'insufficient privilege',
  8: 'unknown failure',
  9: 'path not found',
  21: 'invalid parameter',
});

// CommandLineToArgvW / MSVCRT quoting.
export function quoteWindowsArg(arg) {
  if (typeof arg !== 'string') throw new TypeError(`Argument must be a string, got ${typeof arg}`);
  if (arg !== '' && !/[ \t\n\v"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
    } else if (ch === '"') {
      out += `${'\\'.repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
    } else {
      out += '\\'.repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

export function buildCommandLine(exe, args = []) {
  return [exe, ...args].map(quoteWindowsArg).join(' ');
}

function assertFile(file, label) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`${label} does not exist: ${file}`);
  }
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${file}`);
}

function assertDirectory(dir, label) {
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`${label} does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${dir}`);
}

// Resolves to start_time = null if the child exited before its identity could be read.
export async function launchDetachedViaWmi({ exe, args = [], cwd } = {}) {
  if (typeof exe !== 'string' || !path.win32.isAbsolute(exe)) {
    throw new Error(`exe must be an absolute path: ${String(exe)}`);
  }
  if (typeof cwd !== 'string' || !path.win32.isAbsolute(cwd)) {
    throw new Error(`cwd must be an absolute path: ${String(cwd)}`);
  }
  assertFile(exe, 'exe');
  assertDirectory(cwd, 'cwd');
  const commandLine = buildCommandLine(exe, args);
  if (commandLine.length >= MAX_COMMAND_LINE) {
    throw new Error(`Command line too long (${commandLine.length} chars, limit ${MAX_COMMAND_LINE})`);
  }
  const launchedAt = nowIso();
  const stdout = await runPowerShell(LAUNCH_SCRIPT, {
    HYBRID_PS_CMDLINE: commandLine,
    HYBRID_PS_CWD: cwd,
  });
  const [result] = parseJsonOutput(stdout);
  if (!result) throw new Error('WMI launch produced no output');
  if (result.return_value !== 0) {
    const name = RETURN_VALUE_NAMES[result.return_value] ?? 'unrecognized return value';
    throw new Error(`Win32_Process.Create failed with ReturnValue ${result.return_value} (${name})`);
  }
  return {
    return_value: 0,
    pid: result.pid,
    start_time: result.start_time ?? null,
    command_line: commandLine,
    launched_at: launchedAt,
  };
}
