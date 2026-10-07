// Stand-in for the controller's `codex exec`. Records what it was given (argv, prompt and the
// HYBRID_/CLAUDE_ environment) to fake-controller.json in its cwd (the run directory), then:
//   FAKE_CONTROLLER_TAKEOVER=1  runs `hybrid takeover` with the environment it was handed
//   FAKE_CONTROLLER_MS=<n>      stays alive this long (default 0) before exiting 0
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('codex-cli 0.0.0-fake');
  process.exit(0);
}

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hybrid.mjs');
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const cwd = argv[argv.indexOf('-C') + 1];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(HYBRID_|CLAUDE)/i.test(k)));
const record = { argv, prompt, env, pid: process.pid, takeover: null };

console.log(JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-7000-8000-000000000001' }));
if (process.env.FAKE_CONTROLLER_TAKEOVER === '1') {
  const r = spawnSync(process.execPath, [CLI, 'takeover', '--run', path.basename(cwd), '--json'], { encoding: 'utf8', windowsHide: true });
  record.takeover = { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}
fs.writeFileSync(path.join(cwd, 'fake-controller.json'), JSON.stringify(record, null, 2));
await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CONTROLLER_MS ?? 0)));
console.log(JSON.stringify({ type: 'turn.completed' }));
