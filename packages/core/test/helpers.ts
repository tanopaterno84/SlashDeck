import { EventEmitter } from 'node:events';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, vi } from 'vitest';
import type { ChildProcessLike, Launcher, LaunchOptions } from '../src/discovery/cli-source.js';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const FIXTURE_WORKSPACE = path.join(FIXTURES, 'workspace');

const tempDirs: string[] = [];

/** A temp folder removed after the test file. */
export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `slashdeck-test-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * Copies the fake home to a temp folder and writes installed_plugins.json, which needs the
 * absolute install path of the fixture plugin.
 */
export async function makeHome(options: { registry?: unknown } = {}): Promise<string> {
  const home = await makeTempDir('home');
  await cp(path.join(FIXTURES, 'home'), home, { recursive: true });
  const installPath = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'teamtools', '1.0.0');
  const registry = options.registry ?? {
    version: 2,
    plugins: {
      'teamtools@mkt': [{ scope: 'user', installPath, version: '1.0.0' }],
    },
  };
  await writeFile(
    path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    typeof registry === 'string' ? registry : JSON.stringify(registry, null, 2),
  );
  return home;
}

export interface SyntheticCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  builtin: boolean;
}

/**
 * A synthetic `initialize` answer: invented commands and harmless extra keys, no account data.
 * Like the real CLI (2.1.318), `builtin` is sent only when true, and some commands carry
 * `aliases`.
 */
export function initializeLine(commands: SyntheticCommand[], version = '9.9.9'): string {
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'req_1',
      response: {
        commands: commands.map(({ builtin, ...rest }, i) => ({
          ...rest,
          ...(builtin && { builtin }),
          ...(i % 3 === 0 && { aliases: [] }),
        })),
        claude_code_version: version,
        output_style: 'default',
        available_output_styles: ['default'],
      },
    },
  });
}

export const SAMPLE_COMMANDS: SyntheticCommand[] = [
  {
    name: 'compact',
    description: 'Free up context',
    argumentHint: '<instructions>',
    builtin: true,
  },
  { name: 'clear', description: 'Start a new session', argumentHint: '', builtin: true },
  {
    name: 'mystery-builtin',
    description: 'A builtin with no category',
    argumentHint: '',
    builtin: true,
  },
  { name: '__internal', description: 'Internal', argumentHint: '', builtin: true },
  { name: 'heapdump', description: 'Dump heap', argumentHint: '', builtin: true },
  { name: 'hello', description: 'Say hello (cli)', argumentHint: '[name]', builtin: false },
  { name: 'deploy-check', description: 'Check deploy (cli)', argumentHint: '', builtin: false },
  { name: 'proj-skill', description: 'Project skill (cli)', argumentHint: '', builtin: false },
  { name: 'my-skill', description: 'My skill (cli)', argumentHint: '', builtin: false },
  { name: 'docx', description: 'Docx (cli)', argumentHint: '', builtin: false },
  {
    name: 'anthropic-skills:deep-research',
    description: 'Research (cli)',
    argumentHint: '',
    builtin: false,
  },
  { name: 'teamtools:deploy', description: 'Deploy (cli)', argumentHint: '[env]', builtin: false },
  { name: 'teamtools:release', description: 'Release (cli)', argumentHint: '', builtin: false },
  { name: 'sync-plugin:helper', description: 'Helper (cli)', argumentHint: '', builtin: false },
  { name: 'mcp__server__prompt', description: 'An MCP prompt', argumentHint: '', builtin: false },
];

export interface FakeChild extends ChildProcessLike {
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>;
}

export interface FakeBehaviour {
  /** stdout written after stdin is closed. */
  stdout?: string;
  /** Exit code; null = never exits (to test the timeout). */
  exitCode?: number | null;
  /** Emit an 'error' event with this code instead of running. */
  errorCode?: string;
  /** Called with the launch arguments, while the process is "running". */
  onLaunch?: (command: string, args: string[], options: LaunchOptions) => void | Promise<void>;
}

export interface FakeLauncher extends Launcher {
  calls: { command: string; args: string[]; options: LaunchOptions; stdin: string }[];
  children: FakeChild[];
}

/** A launcher that never starts a real process. */
export function fakeLauncher(behaviour: FakeBehaviour = {}): FakeLauncher {
  const calls: FakeLauncher['calls'] = [];
  const children: FakeChild[] = [];
  const launch = (command: string, args: string[], options: LaunchOptions): FakeChild => {
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const call = { command, args, options, stdin: '' };
    calls.push(call);
    const child = Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(() => {
        setImmediate(() => emitter.emit('close', null));
        return true;
      }),
    }) as unknown as FakeChild;
    children.push(child);

    if (behaviour.errorCode !== undefined) {
      const err = Object.assign(new Error(`spawn ${behaviour.errorCode}`), {
        code: behaviour.errorCode,
      });
      setImmediate(() => emitter.emit('error', err));
      return child;
    }

    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      call.stdin += chunk;
    });
    stdin.on('end', () => {
      void (async () => {
        await behaviour.onLaunch?.(command, args, options);
        const exitCode = behaviour.exitCode === undefined ? 0 : behaviour.exitCode;
        stderr.end('some log line on stderr\n');
        stdout.end(behaviour.stdout ?? '');
        if (exitCode !== null) {
          stdout.on('end', () => setImmediate(() => emitter.emit('close', exitCode)));
          stdout.resume();
        }
      })();
    });
    return child;
  };
  return Object.assign(launch, { calls, children });
}
