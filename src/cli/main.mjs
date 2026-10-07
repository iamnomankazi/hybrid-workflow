// CLI dispatcher: routes argv to a command module, parses its options and prints the result.
// A command is { usage, options (parseArgs config), run(ctx) } and returns { data, text, exitCode?, warnings? }.
// `data` is the --json document, `text` the default human/LLM-readable output.
import { parseArgs } from 'node:util';
import { EXIT } from '../constants.mjs';
import { resolveHome } from '../paths.mjs';
import { HybridError } from '../store.mjs';
import { resolveSession, usageError } from './util.mjs';
import { repoAdd, repoList } from './commands/repo.mjs';
import { doctor } from './commands/doctor.mjs';
import {
  runStart, runList, runClose, runUnhold, runEnsureRunner, takeover,
} from './commands/run.mjs';
import { submit } from './commands/submit.mjs';
import { status } from './commands/status.mjs';
import { wait } from './commands/wait.mjs';
import { result } from './commands/result.mjs';
import { cancel, resume, decide } from './commands/jobctl.mjs';
import { gc } from './commands/gc.mjs';
import { controllerStart } from './commands/controller.mjs';

const COMMANDS = {
  'repo add': repoAdd,
  'repo list': repoList,
  doctor,
  'run start': runStart,
  'run list': runList,
  'run close': runClose,
  'run unhold': runUnhold,
  'run ensure-runner': runEnsureRunner,
  takeover,
  submit,
  status,
  wait,
  result,
  cancel,
  resume,
  decide,
  gc,
  'controller start': controllerStart,
};

const COMMON_OPTIONS = {
  json: { type: 'boolean' },
  run: { type: 'string' },
  session: { type: 'string' },
  help: { type: 'boolean' },
};

const GROUPS = new Set(['repo', 'run', 'controller']);

function usageText() {
  return `usage: hybrid <command> [options]\n${Object.values(COMMANDS).map((c) => `  ${c.usage}`).join('\n')}\n`
    + 'common options: --json --run <id> --session <id>';
}

function findCommand(argv) {
  const [first, second] = argv;
  if (!first) throw usageError(usageText());
  const key = GROUPS.has(first) ? `${first} ${second ?? ''}`.trim() : first;
  const command = COMMANDS[key];
  if (!command) throw usageError(`Unknown command: ${key}\n${usageText()}`);
  return { command, rest: argv.slice(GROUPS.has(first) ? 2 : 1) };
}

function parseCommandArgs(command, args) {
  try {
    return parseArgs({ args, options: { ...COMMON_OPTIONS, ...command.options }, allowPositionals: true, strict: true });
  } catch (err) {
    throw usageError(`${err.message}\nusage: hybrid ${command.usage}`);
  }
}

function printError(err, json) {
  const known = err instanceof HybridError;
  const message = known ? err.message : (err?.message ?? String(err));
  if (json) {
    process.stderr.write(`${JSON.stringify({ error: { code: known ? err.code : 'error', message } })}\n`);
  } else {
    process.stderr.write(`hybrid: ${message}\n`);
  }
  if (!known && process.env.HYBRID_DEBUG) process.stderr.write(`${err?.stack}\n`);
}

export default async function main(argv = process.argv.slice(2), env = process.env) {
  const json = argv.includes('--json');
  try {
    if (argv[0] === '--help' || argv[0] === 'help') {
      process.stdout.write(`${usageText()}\n`);
      return EXIT.ok;
    }
    const { command, rest } = findCommand(argv);
    const { values, positionals } = parseCommandArgs(command, rest);
    if (values.help) {
      process.stdout.write(`usage: hybrid ${command.usage}\n`);
      return EXIT.ok;
    }
    const ctx = {
      home: resolveHome(env), env, values, positionals, json,
      session: resolveSession(values, env), warnings: [],
    };
    const out = await command.run(ctx);
    for (const w of ctx.warnings) process.stderr.write(`hybrid: warning: ${w}\n`);
    process.stdout.write(`${json ? JSON.stringify(out.data) : out.text}\n`);
    return out.exitCode ?? EXIT.ok;
  } catch (err) {
    printError(err, json);
    return err instanceof HybridError ? err.exitCode : EXIT.error;
  }
}
