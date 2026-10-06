// Runner entry: node src/runner/main.mjs --home <HYBRID_HOME> --run <run_id>
import path from 'node:path';
import { assertRunId } from '../store.mjs';
import { Runner } from './runner.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--home') out.home = path.resolve(argv[i + 1] ?? '');
    else if (argv[i] === '--run') out.run = argv[i + 1];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!out.home || !out.run) throw new Error('Usage: main.mjs --home <dir> --run <run_id>');
  assertRunId(out.run);
  return out;
}

let runner = null;

function die(err) {
  if (runner) runner.crash(err);
  else console.error(err?.stack ?? err);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  runner = new Runner({ home: args.home, runId: args.run });
  process.on('uncaughtException', die);
  process.on('unhandledRejection', die);
  // Workers keep running and are adopted by the next runner, so a signal is just a clean exit.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => runner.requestStop(`signal_${signal}`));
  if (!(await runner.start())) return;
  await runner.loop();
}

main().then(() => process.exit(0), die);
