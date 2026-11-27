/**
 * Asks the installed Claude Code CLI for its command list through the `initialize`
 * control request of the stream-json protocol (the one used by the Agent SDK).
 *
 * Only `claude_code_version` and `commands` are read from the response. The response also
 * contains account data: it is never logged, persisted or included in error messages.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';

export const DEFAULT_CLI_TIMEOUT_MS = 15_000;
export const INITIALIZE_REQUEST_ID = 'req_1';
export const INITIALIZE_REQUEST =
  JSON.stringify({
    type: 'control_request',
    request_id: INITIALIZE_REQUEST_ID,
    request: { subtype: 'initialize' },
  }) + '\n';
/** Settings passed with `--settings` so that the user's hooks (e.g. SessionStart) do not run. */
export const NO_HOOKS_SETTINGS = JSON.stringify({ disableAllHooks: true });

/** Fixed arguments; `--settings <file>` is appended at call time. */
export const CLI_BASE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--strict-mcp-config',
] as const;

export interface CliCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  builtin: boolean;
}

export interface CliResult {
  claudeCodeVersion: string;
  commands: CliCommand[];
}

export type CliFailureCode =
  | 'cli-not-found'
  | 'cli-unsafe-path'
  | 'cli-spawn-failed'
  | 'cli-timeout'
  | 'cli-exit'
  | 'cli-no-response'
  | 'cli-error-response'
  | 'cli-invalid-response';

export class CliSourceError extends Error {
  constructor(
    readonly code: CliFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'CliSourceError';
  }
}

/** The subset of a ChildProcess used here; lets tests inject a fake process. */
export interface ChildProcessLike {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: 'error', listener: (err: Error & { code?: string }) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface LaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments: boolean;
}

export type Launcher = (
  command: string,
  args: string[],
  options: LaunchOptions,
) => ChildProcessLike;

export const defaultLauncher: Launcher = (command, args, options) =>
  spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
  });

export interface FetchCliCommandsOptions {
  /** Working directory of the CLI: the workspace. */
  cwd: string;
  /** Explicit path of the executable (overrides SLASHDECK_CLAUDE_PATH and PATH lookup). */
  claudePath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  launcher?: Launcher;
}

// ---------------------------------------------------------------------------
// Executable resolution
// ---------------------------------------------------------------------------

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // Windows env names are case-insensitive, but a plain object is not.
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves the Claude Code executable: explicit option, then SLASHDECK_CLAUDE_PATH, then PATH.
 * On Windows both `claude.exe` (native/WinGet) and `claude.cmd` (npm) are found.
 */
export function resolveClaudeExecutable(
  options: { claudePath?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const override = options.claudePath ?? envValue(env, 'SLASHDECK_CLAUDE_PATH');
  if (override !== undefined && override.trim() !== '') return override.trim();

  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const dirs = (envValue(env, 'PATH') ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '');
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = pathApi.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  throw new CliSourceError('cli-not-found', 'Claude Code executable "claude" not found on PATH');
}

export interface Invocation {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * Builds the process invocation. A Windows `.cmd`/`.bat` shim cannot be spawned without a
 * shell, so it is run through `cmd.exe /d /v:off /s /c "..."` with every token quoted.
 * Tokens containing characters that cmd.exe would still interpret inside quotes (`"`, `%`,
 * line breaks) are rejected, so no shell injection is possible.
 */
export function buildInvocation(
  executable: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Invocation {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) {
    return { command: executable, args: [...args], windowsVerbatimArguments: false };
  }
  const tokens = [executable, ...args];
  for (const token of tokens) {
    if (/["%\r\n]/.test(token)) {
      throw new CliSourceError(
        'cli-unsafe-path',
        `Refusing to run a .cmd shim through cmd.exe: unsafe characters in "${token}"`,
      );
    }
  }
  const line = tokens.map((t) => `"${t}"`).join(' ');
  const comspec = envValue(options.env ?? process.env, 'ComSpec') ?? 'cmd.exe';
  return {
    command: comspec,
    args: ['/d', '/v:off', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const commandSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  argumentHint: z.string().optional(),
  // Observed on 2.1.318: present (true) on builtins, absent on every other command.
  builtin: z.boolean().optional(),
});

// Default zod objects strip unknown keys: account data never survives validation.
const initializeResponseSchema = z.object({
  claude_code_version: z.string().min(1),
  commands: z.array(commandSchema),
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Finds the `control_response` for the initialize request among the stdout lines (other JSON
 * lines, e.g. hook events, and non-JSON lines are skipped) and validates it.
 */
export function parseInitializeOutput(stdout: string): CliResult {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || !line.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const message = asRecord(parsed);
    if (message?.type !== 'control_response') continue;
    const response = asRecord(message.response);
    if (response === undefined) continue;
    if (response.request_id !== undefined && response.request_id !== INITIALIZE_REQUEST_ID) {
      continue;
    }

    if (response.subtype === 'error') {
      const detail = typeof response.error === 'string' ? response.error.slice(0, 200) : '';
      throw new CliSourceError(
        'cli-error-response',
        `Claude Code returned an error for initialize${detail ? `: ${detail}` : ''}`,
      );
    }
    if (response.subtype !== 'success') {
      throw new CliSourceError('cli-invalid-response', 'Unexpected control_response subtype');
    }
    const result = initializeResponseSchema.safeParse(response.response);
    if (!result.success) {
      // Report only paths and issue codes, never the received values.
      const issues = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`)
        .join('; ');
      throw new CliSourceError(
        'cli-invalid-response',
        `Invalid initialize response shape (${issues})`,
      );
    }
    return {
      claudeCodeVersion: result.data.claude_code_version,
      commands: result.data.commands.map((c) => {
        const command: CliCommand = { name: c.name, builtin: c.builtin === true };
        if (c.description !== undefined) command.description = c.description;
        if (c.argumentHint !== undefined) command.argumentHint = c.argumentHint;
        return command;
      }),
    };
  }
  throw new CliSourceError('cli-no-response', 'No control_response line in the CLI output');
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

function runProcess(
  launcher: Launcher,
  invocation: Invocation,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdout = '';

    let child: ChildProcessLike;
    try {
      child = launcher(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: options.env,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      reject(
        code === 'ENOENT'
          ? new CliSourceError(
              'cli-not-found',
              `Claude Code executable not found: ${invocation.command}`,
            )
          : new CliSourceError(
              'cli-spawn-failed',
              `Could not start Claude Code: ${String(code ?? err)}`,
            ),
      );
      return;
    }

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill();
        reject(
          new CliSourceError(
            'cli-timeout',
            `Claude Code did not answer within ${options.timeoutMs} ms`,
          ),
        );
      });
    }, options.timeoutMs);

    child.on('error', (err) => {
      finish(() =>
        reject(
          err.code === 'ENOENT'
            ? new CliSourceError(
                'cli-not-found',
                `Claude Code executable not found: ${invocation.command}`,
              )
            : new CliSourceError(
                'cli-spawn-failed',
                `Could not start Claude Code: ${err.code ?? err.message}`,
              ),
        ),
      );
    });
    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new CliSourceError('cli-exit', `Claude Code exited with code ${String(code)}`));
        } else {
          resolve(stdout);
        }
      });
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    // stderr is drained and discarded: it is never logged.
    child.stderr?.resume();
    child.stdin?.on('error', () => {
      // EPIPE when the process exits early: the close/error handlers report the failure.
    });
    child.stdin?.end(INITIALIZE_REQUEST);
  });
}

/**
 * Runs the `initialize` call and returns the command list. Throws a CliSourceError for every
 * failure mode; callers fall back to the file scan.
 */
export async function fetchCliCommands(options: FetchCliCommandsOptions): Promise<CliResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const executable = resolveClaudeExecutable({
    ...(options.claudePath !== undefined && { claudePath: options.claudePath }),
    env,
    platform,
  });

  // The settings file lives in a private temp dir for the duration of the call.
  const settingsDir = await mkdtemp(path.join(tmpdir(), 'slashdeck-'));
  try {
    const settingsPath = path.join(settingsDir, 'settings.json');
    await writeFile(settingsPath, NO_HOOKS_SETTINGS, 'utf8');
    const invocation = buildInvocation(executable, [...CLI_BASE_ARGS, '--settings', settingsPath], {
      env,
      platform,
    });
    const stdout = await runProcess(options.launcher ?? defaultLauncher, invocation, {
      cwd: options.cwd,
      env,
      timeoutMs: options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
    });
    return parseInitializeOutput(stdout);
  } finally {
    await rm(settingsDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
