/**
 * Detection of the integrated terminals in which an interactive `claude` session is running,
 * so that "Run" is offered only there (CLAUDE.md: never create a terminal to run a command).
 * No `vscode` import: terminal-wiring.ts feeds the VS Code events in.
 *
 * Two signals, both from the VS Code API:
 * 1. Shell integration (VS Code 1.93+): `onDidStartTerminalShellExecution` reports the
 *    command line typed in the shell, `onDidEndTerminalShellExecution` its end. A terminal is
 *    a Claude terminal between the start and the end of an execution whose command line runs
 *    `claude` interactively.
 * 2. A terminal created with `claude` itself as its process (`creationOptions.shellPath`),
 *    until the terminal's process exits.
 * Anything else (terminal names, titles) is not trusted: sending "/init" to a plain shell
 * would try to run a program.
 */

/** `claude <subcommand>` runs a management command, not a session. */
const SUBCOMMANDS = new Set([
  'auth',
  'config',
  'doctor',
  'install',
  'login',
  'logout',
  'mcp',
  'migrate-installer',
  'plugin',
  'plugins',
  'setup-token',
  'update',
  'upgrade',
]);

/** Options that make `claude` print something and exit instead of starting a session. */
const NON_INTERACTIVE_OPTIONS = new Set(['-p', '--print', '-v', '--version', '-h', '--help']);

/** Package runners: `npx @anthropic-ai/claude-code`, `pnpm dlx ...`, `bunx ...`. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const RUNNER_SUBCOMMANDS = new Set(['dlx', 'exec', 'x']);
const CLAUDE_PACKAGE = /^@anthropic-ai\/claude-code(@.*)?$/;

/** Prefixes that run the following command: PowerShell's `&`, `env`, `exec`... */
const PREFIXES = new Set(['&', 'exec', 'command', 'env', 'time', 'nohup', 'noglob', 'builtin']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Segment {
  tokens: string[];
  piped: boolean;
}

/**
 * Splits a shell command line into the segments of a `;`, `&&`, `||` chain, and each
 * segment into words. Quotes are honoured; everything else of the shell syntax is not.
 */
export function splitCommandLine(commandLine: string): Segment[] {
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let piped = false;
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;

  const endToken = () => {
    if (inToken) tokens.push(current);
    current = '';
    inToken = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push({ tokens, piped });
    tokens = [];
    piped = false;
  };

  for (let i = 0; i < commandLine.length; i++) {
    const c = commandLine[i]!;
    const next = commandLine[i + 1];
    if (quote) {
      if (c === quote) quote = null;
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
    } else if (c === ';' || c === '\n' || c === '\r') {
      endSegment();
    } else if ((c === '&' && next === '&') || (c === '|' && next === '|')) {
      endSegment();
      i++;
    } else if (c === '|') {
      endToken();
      piped = true;
    } else if (/\s/.test(c)) {
      endToken();
    } else {
      current += c;
      inToken = true;
    }
  }
  endSegment();
  return segments;
}

function programName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/** Arguments given to `claude` by a segment, or null when the segment does not run it. */
function claudeArguments(tokens: string[]): string[] | null {
  let i = 0;
  while (i < tokens.length && (PREFIXES.has(tokens[i]!) || ENV_ASSIGNMENT.test(tokens[i]!))) i++;
  const program = tokens[i];
  if (program === undefined) return null;
  const name = programName(program);
  if (name === 'claude') return tokens.slice(i + 1);

  let rest = tokens.slice(i + 1);
  if (name === 'pnpm' || name === 'yarn' || name === 'npm' || name === 'bun') {
    if (!RUNNER_SUBCOMMANDS.has(rest[0] ?? '')) return null;
    rest = rest.slice(1);
  } else if (!RUNNERS.has(name)) {
    return null;
  }
  const pkg = rest.findIndex((token) => CLAUDE_PACKAGE.test(token));
  return pkg === -1 ? null : rest.slice(pkg + 1);
}

/**
 * Whether a command line starts an interactive Claude Code session: `claude`, `claude -c`,
 * `claude "fix the build"`, `& "C:\...\claude.exe" --resume`, `cd app && claude`,
 * `npx @anthropic-ai/claude-code`. Not: `claude -p ...`, `claude mcp list`, `claude --version`,
 * `echo x | claude` (piped: print mode).
 */
export function isInteractiveClaudeCommandLine(commandLine: string): boolean {
  const segments = splitCommandLine(commandLine);
  const last = segments.at(-1);
  if (!last || last.piped) return false;
  const args = claudeArguments(last.tokens);
  if (args === null) return false;
  if (args.some((a) => NON_INTERACTIVE_OPTIONS.has(a) || a.startsWith('--print='))) return false;
  const first = args[0];
  return first === undefined || first.startsWith('-') || !SUBCOMMANDS.has(first.toLowerCase());
}

/** Whether a terminal created with this process is Claude Code itself. */
export function isClaudeShellPath(shellPath: string | undefined): boolean {
  return shellPath !== undefined && programName(shellPath.trim()) === 'claude';
}

/**
 * Terminals (of any type T, `vscode.Terminal` in the extension) in which an interactive
 * `claude` is running. `executions` are compared by identity: VS Code passes the same
 * execution object to the start and end events.
 */
export class ClaudeTerminalTracker<T> {
  private readonly executions = new Map<T, Set<unknown>>();
  private readonly processes = new Set<T>();
  private readonly listeners = new Set<() => void>();

  /** Called whenever the set of Claude terminals may have changed. */
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private changed(before: boolean, terminal: T): void {
    if (before !== this.has(terminal)) for (const listener of this.listeners) listener();
  }

  executionStarted(terminal: T, execution: unknown, commandLine: string): void {
    if (!isInteractiveClaudeCommandLine(commandLine)) return;
    const before = this.has(terminal);
    const set = this.executions.get(terminal) ?? new Set<unknown>();
    set.add(execution);
    this.executions.set(terminal, set);
    this.changed(before, terminal);
  }

  executionEnded(terminal: T, execution: unknown): void {
    const set = this.executions.get(terminal);
    if (!set?.has(execution)) return;
    const before = this.has(terminal);
    set.delete(execution);
    if (set.size === 0) this.executions.delete(terminal);
    this.changed(before, terminal);
  }

  /** A terminal that exists (at activation or when opened); `shellPath` from its options. */
  terminalOpened(terminal: T, shellPath: string | undefined, exited: boolean): void {
    if (exited || !isClaudeShellPath(shellPath)) return;
    const before = this.has(terminal);
    this.processes.add(terminal);
    this.changed(before, terminal);
  }

  /** The terminal was closed, or its process exited. */
  terminalClosed(terminal: T): void {
    const before = this.has(terminal);
    this.executions.delete(terminal);
    this.processes.delete(terminal);
    this.changed(before, terminal);
  }

  has(terminal: T): boolean {
    return this.processes.has(terminal) || (this.executions.get(terminal)?.size ?? 0) > 0;
  }

  terminals(): T[] {
    return [...new Set([...this.processes, ...this.executions.keys()])];
  }
}

export interface RunPlan {
  /** Text typed into Claude Code's input. */
  text: string;
  /** Whether Enter is pressed after it. */
  submit: boolean;
}

/**
 * What "Run" types. A command that declares arguments (an argument hint) is typed with a
 * trailing space and not submitted: the user completes it in Claude Code, where the hint is
 * shown, and presses Enter. Any other command is submitted.
 */
export function runPlan(entry: { name: string; argumentHint?: string }): RunPlan {
  const takesArguments = (entry.argumentHint ?? '').trim() !== '';
  return takesArguments
    ? { text: `${entry.name} `, submit: false }
    : { text: entry.name, submit: true };
}

/**
 * The terminal "Run" sends to: the active one when it runs Claude Code, else the only one;
 * with several and none active, null (the caller asks the user).
 */
export function pickTerminal<T>(candidates: readonly T[], active: T | undefined): T | null {
  if (active !== undefined && candidates.includes(active)) return active;
  return candidates.length === 1 ? candidates[0]! : null;
}
