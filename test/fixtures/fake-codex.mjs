// Stand-in for `codex exec`, driven by directives inside the prompt text (one per line):
//   FAKE_SCENARIO: <name>   FAKE_SLEEP_MS: <n>   FAKE_WRITE: <relpath> => <content>
// Scenarios: success (default) fail quota auth hang slow no-final exit0-no-turn spawn-child dump-env,
// pause (thread.started, silence for FAKE_SLEEP_MS, then 2.5 s of events, then success).
// Never writes outside its cwd.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);

if (argv[0] === '--version') {
  console.log('codex-cli 0.0.0-fake');
  process.exit(0);
}

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const isResume = argv[0] === 'exec' && argv[1] === 'resume';
const sessionId = isResume ? argv[argv.length - 2] : null;
const lastMessageFile = flag('-o');
const cwd = flag('-C') ?? process.cwd();

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const lines = prompt.split(/\r?\n/);
const directive = (name) => lines.map((l) => new RegExp(`^${name}:\s*(.*)$`).exec(l)).find(Boolean)?.[1].trim();
const scenario = directive('FAKE_SCENARIO') ?? 'success';
const sleepMs = Number(directive('FAKE_SLEEP_MS') ?? 600000);
const writes = lines.map((l) => /^FAKE_WRITE:\s*(\S+)\s*=>\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]);
const jobId = /^- job_id: (\S+)/m.exec(prompt)?.[1] ?? 'unknown';

const emit = (event) => fs.writeSync(1, `${JSON.stringify(event)}\n`);
const message = (id, text) => emit({ type: 'item.completed', item: { id, type: 'agent_message', text } });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function applyWrites() {
  for (const [rel, content] of writes) {
    const target = path.resolve(cwd, rel);
    if (path.relative(cwd, target).startsWith('..')) throw new Error(`FAKE_WRITE escapes cwd: ${rel}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function finishSuccess() {
  applyWrites();
  const report = JSON.stringify({
    job_id: jobId, status: 'done', summary: 'fake work done', files_changed: writes.map(([rel]) => rel), tests: 'none', notes: '',
  });
  message('item_1', report);
  if (lastMessageFile) fs.writeFileSync(lastMessageFile, report);
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
  process.exit(0);
}

function failTurn(text, { errorEvent = false } = {}) {
  if (errorEvent) emit({ type: 'error', message: text });
  emit({ type: 'turn.failed', error: { message: text } });
  process.exit(1);
}

emit({ type: 'thread.started', thread_id: sessionId ?? crypto.randomUUID() });
if (scenario === 'exit0-no-turn') process.exit(0);
if (scenario === 'hang' || scenario === 'pause') await wait(sleepMs);
emit({ type: 'turn.started' });
emit({ type: 'item.completed', item: { id: 'argv', type: 'fake_argv', argv } });

switch (scenario) {
  case 'fail':
    failTurn('boom');
    break;
  case 'quota':
    failTurn("You've hit your usage limit. Try again later.", { errorEvent: true });
    break;
  case 'auth':
    failTurn('401 Unauthorized: refresh token was revoked');
    break;
  case 'slow':
  case 'pause': {
    const end = Date.now() + (scenario === 'pause' ? 2500 : sleepMs);
    for (let i = 0; Date.now() < end; i++) {
      message(`slow_${i}`, `working ${i}`);
      await wait(200);
    }
    finishSuccess();
    break;
  }
  case 'no-final':
    emit({ type: 'turn.completed', usage: {} });
    process.exit(0);
    break;
  case 'spawn-child': {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)', cwd], {
      detached: true, windowsHide: true, stdio: 'ignore',
    });
    child.unref();
    emit({ type: 'item.completed', item: { id: 'child', type: 'fake_child', pid: child.pid } });
    await wait(sleepMs);
    break;
  }
  case 'dump-env':
    fs.writeFileSync(path.join(cwd, 'env.json'), JSON.stringify(process.env, null, 2));
    fs.writeFileSync(path.join(cwd, 'path-dirs.txt'), (process.env.Path ?? process.env.PATH ?? '').split(';').join('\n'));
    finishSuccess();
    break;
  default:
    finishSuccess();
}
