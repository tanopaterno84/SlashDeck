import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeTerminalTracker,
  isClaudeShellPath,
  isInteractiveClaudeCommandLine,
  pickTerminal,
  runPlan,
  splitCommandLine,
} from '../src/terminals.js';

describe('isInteractiveClaudeCommandLine', () => {
  it.each([
    'claude',
    '  claude  ',
    'claude -c',
    'claude --continue',
    'claude --resume abc',
    'claude --model opus',
    'claude "fix the build"',
    'CLAUDE',
    'claude.exe',
    './node_modules/.bin/claude',
    '& "C:\\Program Files\\Claude\\claude.exe" --resume',
    "& 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'",
    'cd app && claude',
    'cd app; claude',
    'FOO=1 claude',
    'env FOO=1 claude',
    'npx @anthropic-ai/claude-code',
    'npx -y @anthropic-ai/claude-code@latest --continue',
    'pnpm dlx @anthropic-ai/claude-code',
    'claude doctor-notes', // a prompt, not the `doctor` subcommand
  ])('detects %j', (line) => {
    expect(isInteractiveClaudeCommandLine(line)).toBe(true);
  });

  it.each([
    '',
    'ls',
    'git commit -m "claude"',
    'echo claude',
    'claude -p "hello"',
    'claude --print hi',
    'claude --print=json',
    'claude --version',
    'claude -v',
    'claude --help',
    'claude mcp list',
    'claude config get',
    'claude update',
    'claude doctor',
    'claude plugin install x',
    'echo hi | claude',
    'claude && echo done', // only the last command of a chain is looked at
    'claudette',
    'claude-code',
    'npx some-other-package',
    'npm install @anthropic-ai/claude-code',
  ])('ignores %j', (line) => {
    expect(isInteractiveClaudeCommandLine(line)).toBe(false);
  });
});

describe('splitCommandLine', () => {
  it('honours quotes and chain operators', () => {
    expect(splitCommandLine('a "b c" && d \'e;f\' || g; h | i')).toEqual([
      { tokens: ['a', 'b c'], piped: false },
      { tokens: ['d', 'e;f'], piped: false },
      { tokens: ['g'], piped: false },
      { tokens: ['h', 'i'], piped: true },
    ]);
  });
});

describe('isClaudeShellPath', () => {
  it('recognises a terminal whose process is claude', () => {
    expect(isClaudeShellPath('claude')).toBe(true);
    expect(isClaudeShellPath('C:\\Users\\me\\.local\\bin\\claude.exe')).toBe(true);
    expect(isClaudeShellPath('/usr/local/bin/claude')).toBe(true);
    expect(isClaudeShellPath('pwsh.exe')).toBe(false);
    expect(isClaudeShellPath(undefined)).toBe(false);
  });
});

describe('ClaudeTerminalTracker', () => {
  it('tracks a claude execution from its start to its end', () => {
    const tracker = new ClaudeTerminalTracker<string>();
    const listener = vi.fn();
    tracker.onDidChange(listener);
    const exec = {};
    tracker.executionStarted('t1', exec, 'claude');
    expect(tracker.has('t1')).toBe(true);
    expect(tracker.terminals()).toEqual(['t1']);
    expect(listener).toHaveBeenCalledTimes(1);
    tracker.executionEnded('t1', exec);
    expect(tracker.has('t1')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores executions that are not claude, and ends of unknown executions', () => {
    const tracker = new ClaudeTerminalTracker<string>();
    const listener = vi.fn();
    tracker.onDidChange(listener);
    tracker.executionStarted('t1', {}, 'npm test');
    tracker.executionEnded('t1', {});
    expect(tracker.terminals()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('compares executions by identity', () => {
    const tracker = new ClaudeTerminalTracker<string>();
    const first = {};
    tracker.executionStarted('t1', first, 'claude');
    tracker.executionEnded('t1', {}); // another execution of the same terminal
    expect(tracker.has('t1')).toBe(true);
    tracker.executionEnded('t1', first);
    expect(tracker.has('t1')).toBe(false);
  });

  it('tracks terminals whose own process is claude until they close', () => {
    const tracker = new ClaudeTerminalTracker<string>();
    tracker.terminalOpened('t1', 'C:\\bin\\claude.exe', false);
    tracker.terminalOpened('t2', 'pwsh.exe', false);
    tracker.terminalOpened('t3', 'claude', true); // already exited
    expect(tracker.terminals()).toEqual(['t1']);
    tracker.terminalClosed('t1');
    expect(tracker.terminals()).toEqual([]);
  });

  it('forgets a closed terminal with a running execution', () => {
    const tracker = new ClaudeTerminalTracker<string>();
    const listener = vi.fn();
    tracker.onDidChange(listener);
    tracker.executionStarted('t1', {}, 'claude');
    tracker.terminalClosed('t1');
    expect(tracker.terminals()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
    tracker.terminalClosed('t1'); // no change, no event
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stops notifying a disposed listener', () => {
    const tracker = new ClaudeTerminalTracker<string>();
    const listener = vi.fn();
    tracker.onDidChange(listener).dispose();
    tracker.executionStarted('t1', {}, 'claude');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('pickTerminal', () => {
  it('prefers the active terminal, then the only one, else asks', () => {
    expect(pickTerminal(['a', 'b'], 'b')).toBe('b');
    expect(pickTerminal(['a'], 'z')).toBe('a');
    expect(pickTerminal(['a'], undefined)).toBe('a');
    expect(pickTerminal(['a', 'b'], 'z')).toBeNull();
    expect(pickTerminal([], undefined)).toBeNull();
  });
});

describe('runPlan', () => {
  it('submits a command without arguments', () => {
    expect(runPlan({ name: '/compact' })).toEqual({ text: '/compact', submit: true });
    expect(runPlan({ name: '/clear', argumentHint: '  ' })).toEqual({
      text: '/clear',
      submit: true,
    });
  });

  it('types a command with arguments and lets the user complete it', () => {
    expect(runPlan({ name: '/gxrr:wiki', argumentHint: '<path>' })).toEqual({
      text: '/gxrr:wiki ',
      submit: false,
    });
  });
});
