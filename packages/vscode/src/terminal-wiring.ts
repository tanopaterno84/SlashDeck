/**
 * Feeds the VS Code terminal events into the ClaudeTerminalTracker (terminals.ts) and keeps
 * the `slashdeck.claudeTerminalDetected` context key, which shows or hides "Run".
 *
 * Needs VS Code 1.93 (stable shell integration API). Executions that started before the
 * extension activated are not reported by VS Code, so a `claude` already running then is
 * not detected until it is restarted.
 */
import * as vscode from 'vscode';
import { ClaudeTerminalTracker } from './terminals.js';

export const CONTEXT_KEY = 'slashdeck.claudeTerminalDetected';

function shellPathOf(terminal: vscode.Terminal): string | undefined {
  const options = terminal.creationOptions;
  return 'shellPath' in options ? options.shellPath : undefined;
}

export function trackClaudeTerminals(log: vscode.LogOutputChannel): {
  tracker: ClaudeTerminalTracker<vscode.Terminal>;
  disposables: vscode.Disposable[];
} {
  const tracker = new ClaudeTerminalTracker<vscode.Terminal>();
  const update = () => {
    const count = tracker.terminals().length;
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, count > 0);
  };
  const disposables: vscode.Disposable[] = [
    tracker.onDidChange(() => {
      log.info(`terminals running Claude Code: ${tracker.terminals().length}`);
      update();
    }),
    vscode.window.onDidStartTerminalShellExecution((e) => {
      tracker.executionStarted(e.terminal, e.execution, e.execution.commandLine.value);
    }),
    vscode.window.onDidEndTerminalShellExecution((e) => {
      tracker.executionEnded(e.terminal, e.execution);
    }),
    vscode.window.onDidOpenTerminal((terminal) => {
      tracker.terminalOpened(terminal, shellPathOf(terminal), terminal.exitStatus !== undefined);
    }),
    vscode.window.onDidCloseTerminal((terminal) => tracker.terminalClosed(terminal)),
    // A terminal whose process is `claude` stays open after the process exits.
    vscode.window.onDidChangeTerminalState((terminal) => {
      if (terminal.exitStatus !== undefined) tracker.terminalClosed(terminal);
    }),
  ];
  for (const terminal of vscode.window.terminals) {
    tracker.terminalOpened(terminal, shellPathOf(terminal), terminal.exitStatus !== undefined);
  }
  update();
  return { tracker, disposables };
}
