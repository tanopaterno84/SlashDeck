/**
 * The `slashdeck` command line. stdout carries only the result (JSON, or Markdown with
 * `scan --markdown`); logs and warnings go to stderr. On failure stdout is empty.
 *
 * Exit codes: 0 success (also when the scan fell back to files); 1 error; 2 usage error
 * (including an invalid edit on stdin or an empty command name); 3 no cache for the
 * workspace yet (`scan --cached`, `get`, `pin`, `edit`); 4 command not in the cached catalog
 * (`get`, `pin`, `edit`).
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  clearCache,
  editCommand,
  loadCachedView,
  normalizeCommandName,
  pinCommand,
  resetCommand,
  scanAndCache,
  unpinCommand,
  type ScanAndCacheOptions,
  type StoreOptions,
  type WriteResult,
} from './api.js';
import { SlashDeckError, type SlashDeckErrorCode } from './errors.js';
import { renderMarkdown } from './markdown.js';
import type { CommandEditInput } from './state/edit.js';
import type { ResolvedView, ScanWarning } from './types.js';
import { errorMessage, stripBom } from './util.js';

export interface CliIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Reads all of stdin (for `edit`); default: process.stdin. */
  readStdin?: () => Promise<string>;
  /** Test hook: extra options passed to the scan and to the cache and state calls. */
  scanOverrides?: Partial<ScanAndCacheOptions>;
}

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  noCache: 3,
  notInCatalog: 4,
} as const;

export const USAGE = `Usage: slashdeck <command> [options]

Commands:
  scan                 Scan the slash commands, update the cache, print the resolved view
  scan --cached        Print the resolved view of the last scan, without calling Claude Code
  get <command>        Print one command of the cached resolved view
  pin <command>        Pin a command          unpin <command>   Unpin a command
  edit <command>       Edit a command: reads JSON from stdin, e.g.
                       {"description": "...", "guide": {"whenToUse": "..."}}
                       (null removes your value for that field)
  reset <command>      Remove your edits of a command (pins stay)
  cache clear          Delete the cache of the workspace (--all: of every workspace)

Command names are accepted with or without the leading "/".

Options:
  -w, --workspace <path>   Workspace folder (default: current directory)
      --json               Print JSON (default)
      --markdown           scan: print Markdown, grouped by category
      --cached             scan: use the last cache instead of scanning
      --all                cache clear: every workspace
  -q, --quiet              Do not log warnings on stderr (they stay in the output)
      --claude-path <path> Claude Code executable (or env SLASHDECK_CLAUDE_PATH)
  -h, --help               Show this help

Environment: SLASHDECK_CACHE_DIR and SLASHDECK_CONFIG_DIR move the cache and user state.

Exit codes: 0 ok; 1 error; 2 usage error; 3 no cache yet (run scan); 4 command not in
the cached catalog. On failure stdout is empty and the reason is on stderr.
`;

async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new SlashDeckError('invalid-edit', 'edit reads a JSON object from stdin');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function defaultIo(): CliIo {
  return { stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() };
}

class UsageError extends Error {}

const EXIT_FOR: Record<SlashDeckErrorCode, number> = {
  'no-cache': EXIT.noCache,
  'not-in-catalog': EXIT.notInCatalog,
  'invalid-command-name': EXIT.usage,
  'invalid-edit': EXIT.usage,
  'state-unreadable': EXIT.error,
  'state-busy': EXIT.error,
};

type Values = ReturnType<typeof parseCliArgs>['values'];

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  // `pnpm run dev -- scan …` may forward the "--" separator.
  const args = argv[0] === '--' ? argv.slice(1) : argv;

  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseCliArgs(args));
    if (values.help) {
      io.stderr.write(USAGE);
      return EXIT.ok;
    }
    checkUsage(values, positionals);
  } catch (err) {
    io.stderr.write(`slashdeck: ${errorMessage(err)}\n\n${USAGE}`);
    return EXIT.usage;
  }

  const workspace = path.resolve(io.cwd, values.workspace ?? '.');
  try {
    if (!statSync(workspace).isDirectory()) throw new Error('not a directory');
  } catch {
    io.stderr.write(`slashdeck: workspace is not a directory: ${workspace}\n`);
    return EXIT.error;
  }

  const claudePath = values['claude-path'];
  const claudeDir = io.env.CLAUDE_CONFIG_DIR;
  const options: ScanAndCacheOptions = {
    workspace,
    env: io.env,
    ...(claudePath !== undefined && { claudePath }),
    ...(claudeDir !== undefined && claudeDir !== '' && { claudeDir }),
    ...io.scanOverrides,
  };
  const [command, name] = positionals as [string, string | undefined];

  try {
    switch (command) {
      case 'scan':
        return await runScan(io, values, options);
      case 'get':
        return await runGet(io, values, options, name!);
      case 'cache':
        return printWrite(io, await clearCache({ ...options, all: values.all === true }));
      case 'pin':
        return printWrite(io, await pinCommand(options, name!));
      case 'unpin':
        return printWrite(io, await unpinCommand(options, name!));
      case 'reset':
        return printWrite(io, await resetCommand(options, name!));
      case 'edit': {
        normalizeCommandName(name!);
        const input = parseEdit(await (io.readStdin ?? readProcessStdin)());
        return printWrite(io, await editCommand(options, name!, input));
      }
      default:
        return EXIT.usage; // unreachable: checkUsage rejects unknown commands
    }
  } catch (err) {
    if (err instanceof SlashDeckError) {
      io.stderr.write(`slashdeck: ${err.message}\n`);
      return EXIT_FOR[err.code];
    }
    io.stderr.write(`slashdeck: ${command} failed: ${errorMessage(err)}\n`);
    return EXIT.error;
  }
}

const NAMED = new Set(['get', 'pin', 'unpin', 'edit', 'reset']);

function checkUsage(values: Values, positionals: string[]): void {
  const [command, ...rest] = positionals;
  if (command === undefined) throw new UsageError('missing command');
  const known =
    (command === 'scan' && rest.length === 0) ||
    (command === 'cache' && rest.length === 1 && rest[0] === 'clear') ||
    (NAMED.has(command) && rest.length === 1);
  if (!known) {
    if (NAMED.has(command) && rest.length === 0) {
      throw new UsageError(`${command} needs a command name`);
    }
    throw new UsageError(`unknown command "${positionals.join(' ')}"`);
  }
  if (values.json && values.markdown) {
    throw new UsageError('--json and --markdown cannot be used together');
  }
  if (command !== 'scan' && values.markdown) throw new UsageError('--markdown is for scan only');
  if (command !== 'scan' && values.cached) throw new UsageError('--cached is for scan only');
  if (command !== 'cache' && values.all) throw new UsageError('--all is for cache clear only');
}

function logWarnings(io: CliIo, values: Values, warnings: ScanWarning[]): void {
  if (values.quiet) return;
  for (const warning of warnings) {
    io.stderr.write(`slashdeck: warning [${warning.code}] ${warning.message}\n`);
  }
}

function noCache(options: StoreOptions): SlashDeckError {
  return new SlashDeckError(
    'no-cache',
    `no cached catalog for ${options.workspace}: run "slashdeck scan" first`,
  );
}

async function runScan(io: CliIo, values: Values, options: ScanAndCacheOptions) {
  let view: ResolvedView;
  if (values.cached) {
    const cached = await loadCachedView(options);
    if (!cached) throw noCache(options);
    view = cached;
  } else {
    view = await scanAndCache(options);
  }
  logWarnings(io, values, view.warnings);
  io.stdout.write(values.markdown ? renderMarkdown(view) : JSON.stringify(view, null, 2) + '\n');
  return EXIT.ok;
}

async function runGet(io: CliIo, values: Values, options: StoreOptions, command: string) {
  const name = normalizeCommandName(command);
  const view = await loadCachedView(options);
  if (!view) throw noCache(options);
  const entry = view.commands[name];
  if (!entry) throw new SlashDeckError('not-in-catalog', `${name} is not in the cached catalog`);
  logWarnings(io, values, view.warnings);
  io.stdout.write(JSON.stringify(entry, null, 2) + '\n');
  return EXIT.ok;
}

function printWrite(io: CliIo, result: WriteResult): number {
  io.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return EXIT.ok;
}

function parseEdit(text: string): CommandEditInput {
  try {
    return JSON.parse(stripBom(text).trim() || 'null') as CommandEditInput;
  } catch (err) {
    throw new SlashDeckError(
      'invalid-edit',
      `edit: stdin is not valid JSON (${errorMessage(err)})`,
    );
  }
}

function parseCliArgs(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      workspace: { type: 'string', short: 'w' },
      json: { type: 'boolean' },
      markdown: { type: 'boolean' },
      cached: { type: 'boolean' },
      all: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      'claude-path': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

/**
 * Makes the process exit quietly when the reader of a stream goes away (EPIPE), for example
 * `slashdeck scan | head`. Without a listener, Node reports the error as an uncaught
 * exception with a stack trace. Other stream errors are rethrown.
 */
export function exitQuietlyOnBrokenPipe(
  stream: { on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown },
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  stream.on('error', (err) => {
    if (err.code === 'EPIPE') exit(0);
    else throw err;
  });
}
