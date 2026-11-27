import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLI_BASE_ARGS,
  CliSourceError,
  buildInvocation,
  fetchCliCommands,
  parseInitializeOutput,
  resolveClaudeExecutable,
} from '../src/discovery/cli-source.js';
import { SAMPLE_COMMANDS, fakeLauncher, initializeLine, makeTempDir } from './helpers.js';

async function expectCliError(promise: Promise<unknown>, code: string): Promise<CliSourceError> {
  const err = await promise.then(
    () => {
      throw new Error('expected a CliSourceError');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CliSourceError);
  expect((err as CliSourceError).code).toBe(code);
  return err as CliSourceError;
}

function expectCliErrorSync(fn: () => unknown, code: string): CliSourceError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliSourceError);
    expect((err as CliSourceError).code).toBe(code);
    return err as CliSourceError;
  }
  throw new Error('expected a CliSourceError');
}

describe('parseInitializeOutput', () => {
  it('extracts version and commands, dropping every other key', () => {
    const result = parseInitializeOutput(
      initializeLine(SAMPLE_COMMANDS.slice(0, 2), '1.2.3') + '\n',
    );
    expect(result).toEqual({
      claudeCodeVersion: '1.2.3',
      commands: [
        {
          name: 'compact',
          description: 'Free up context',
          argumentHint: '<instructions>',
          builtin: true,
        },
        { name: 'clear', description: 'Start a new session', argumentHint: '', builtin: true },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('output_style');
    expect(JSON.stringify(result)).not.toContain('aliases');
  });

  it('treats a missing builtin flag as a non-builtin command', () => {
    const line = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req_1',
        response: {
          claude_code_version: '1.0.0',
          commands: [
            { name: 'team:x', description: 'd', argumentHint: '', aliases: [] },
            { name: 'y', description: 'd', argumentHint: '', builtin: false },
            { name: 'z', description: 'd', argumentHint: '', builtin: true },
          ],
        },
      },
    });
    expect(parseInitializeOutput(line).commands.map((c) => c.builtin)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('skips non-JSON lines, hook events and responses to other requests', () => {
    const other = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req_other', response: {} },
    });
    const stdout = [
      'Warning: something printed by a wrapper',
      '{not json',
      JSON.stringify({ type: 'system', subtype: 'hook_started' }),
      JSON.stringify({ type: 'system', subtype: 'hook_response' }),
      other,
      initializeLine([{ name: 'x', builtin: false }]),
      '',
    ].join('\r\n');
    const result = parseInitializeOutput(stdout);
    expect(result.commands).toEqual([{ name: 'x', builtin: false }]);
  });

  it('reports an error subtype', () => {
    const line = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'req_1', error: 'not logged in' },
    });
    const err = expectCliErrorSync(() => parseInitializeOutput(line), 'cli-error-response');
    expect(err.message).toContain('not logged in');
  });

  it('reports a missing control_response', () => {
    expectCliErrorSync(
      () => parseInitializeOutput('hello\n{"type":"system"}\n'),
      'cli-no-response',
    );
    expectCliErrorSync(() => parseInitializeOutput(''), 'cli-no-response');
  });

  it('reports an invalid shape without echoing values', () => {
    const line = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req_1',
        response: {
          claude_code_version: '1.0.0',
          commands: [{ name: 'SECRET-VALUE', builtin: 'yes' }],
        },
      },
    });
    const err = expectCliErrorSync(() => parseInitializeOutput(line), 'cli-invalid-response');
    expect(err.message).toContain('commands.0.builtin');
    expect(err.message).not.toContain('SECRET-VALUE');
    expect(err.message).not.toContain('yes');
  });

  it('reports a missing commands array', () => {
    const line = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', response: { claude_code_version: '1.0.0' } },
    });
    expectCliErrorSync(() => parseInitializeOutput(line), 'cli-invalid-response');
  });
});

describe('resolveClaudeExecutable', () => {
  it('prefers the explicit option, then SLASHDECK_CLAUDE_PATH', () => {
    const env = { SLASHDECK_CLAUDE_PATH: '/env/claude', PATH: '' };
    expect(resolveClaudeExecutable({ claudePath: '/opt/claude', env })).toBe('/opt/claude');
    expect(resolveClaudeExecutable({ env })).toBe('/env/claude');
  });

  it('finds claude.cmd on a Windows PATH', async () => {
    const dir = await makeTempDir('path');
    await writeFile(path.join(dir, 'claude.cmd'), '@echo off\n');
    const found = resolveClaudeExecutable({
      env: { Path: `C:\\nowhere;${dir}` },
      platform: 'win32',
    });
    expect(found.toLowerCase()).toBe(path.win32.join(dir, 'claude.cmd').toLowerCase());
  });

  it('prefers claude.exe over claude.cmd in the same folder', async () => {
    const dir = await makeTempDir('path');
    await writeFile(path.join(dir, 'claude.cmd'), '');
    await writeFile(path.join(dir, 'claude.exe'), '');
    const found = resolveClaudeExecutable({ env: { PATH: dir }, platform: 'win32' });
    expect(found.toLowerCase().endsWith('claude.exe')).toBe(true);
  });

  it('throws cli-not-found when nothing is on PATH', () => {
    expectCliErrorSync(
      () => resolveClaudeExecutable({ env: { PATH: '' }, platform: 'linux' }),
      'cli-not-found',
    );
  });
});

describe('buildInvocation', () => {
  it('runs an .exe directly', () => {
    const inv = buildInvocation('C:\\bin\\claude.exe', ['-p'], { platform: 'win32', env: {} });
    expect(inv).toEqual({
      command: 'C:\\bin\\claude.exe',
      args: ['-p'],
      windowsVerbatimArguments: false,
    });
  });

  it('runs a .cmd shim through cmd.exe with quoted tokens', () => {
    const inv = buildInvocation(
      'C:\\Program Files\\npm\\claude.cmd',
      ['-p', '--settings', 'C:\\t\\s.json'],
      {
        platform: 'win32',
        env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      },
    );
    expect(inv.command).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(inv.windowsVerbatimArguments).toBe(true);
    expect(inv.args).toEqual([
      '/d',
      '/v:off',
      '/s',
      '/c',
      '""C:\\Program Files\\npm\\claude.cmd" "-p" "--settings" "C:\\t\\s.json""',
    ]);
  });

  it('rejects cmd.exe metacharacters that quoting cannot neutralise', () => {
    for (const bad of ['C:\\a%PATH%\\claude.cmd', 'C:\\a"b\\claude.cmd']) {
      expectCliErrorSync(
        () => buildInvocation(bad, ['-p'], { platform: 'win32', env: {} }),
        'cli-unsafe-path',
      );
    }
  });

  it('does not use a shell on other platforms', () => {
    const inv = buildInvocation('/usr/bin/claude.cmd', ['-p'], { platform: 'linux' });
    expect(inv.command).toBe('/usr/bin/claude.cmd');
  });
});

describe('fetchCliCommands', () => {
  const base = { cwd: '/some/workspace', claudePath: '/fake/claude', platform: 'linux' as const };

  it('sends initialize, passes the no-hooks settings file and parses the answer', async () => {
    let settingsContent = '';
    const launcher = fakeLauncher({
      stdout: initializeLine(SAMPLE_COMMANDS) + '\n',
      onLaunch: async (_cmd, args) => {
        const settingsPath = args[args.indexOf('--settings') + 1];
        settingsContent = await readFile(settingsPath!, 'utf8');
      },
    });
    const result = await fetchCliCommands({ ...base, launcher });

    expect(result.claudeCodeVersion).toBe('9.9.9');
    expect(result.commands).toHaveLength(SAMPLE_COMMANDS.length);
    expect(launcher.calls).toHaveLength(1);
    const call = launcher.calls[0]!;
    expect(call.command).toBe('/fake/claude');
    expect(call.options.cwd).toBe('/some/workspace');
    expect(call.args.slice(0, CLI_BASE_ARGS.length)).toEqual([...CLI_BASE_ARGS]);
    expect(call.args).toContain('--strict-mcp-config');
    expect(call.args[call.args.length - 2]).toBe('--settings');
    expect(JSON.parse(settingsContent)).toEqual({ disableAllHooks: true });
    expect(JSON.parse(call.stdin)).toEqual({
      type: 'control_request',
      request_id: 'req_1',
      request: { subtype: 'initialize' },
    });
    expect(call.stdin.endsWith('\n')).toBe(true);
  });

  it('removes the temporary settings file afterwards', async () => {
    let settingsPath = '';
    const launcher = fakeLauncher({
      stdout: initializeLine([]),
      onLaunch: (_cmd, args) => {
        settingsPath = args[args.indexOf('--settings') + 1]!;
      },
    });
    await fetchCliCommands({ ...base, launcher });
    await expect(readFile(settingsPath)).rejects.toThrow();
  });

  it('fails with cli-exit on a non-zero exit code', async () => {
    const launcher = fakeLauncher({ stdout: initializeLine([]), exitCode: 1 });
    await expectCliError(fetchCliCommands({ ...base, launcher }), 'cli-exit');
  });

  it('fails with cli-timeout and kills the process', async () => {
    const launcher = fakeLauncher({ exitCode: null });
    await expectCliError(fetchCliCommands({ ...base, launcher, timeoutMs: 50 }), 'cli-timeout');
    expect(launcher.children[0]!.kill).toHaveBeenCalled();
  });

  it('fails with cli-not-found when the executable does not exist', async () => {
    const launcher = fakeLauncher({ errorCode: 'ENOENT' });
    await expectCliError(fetchCliCommands({ ...base, launcher }), 'cli-not-found');
  });

  it('fails with cli-spawn-failed on other spawn errors', async () => {
    const launcher = fakeLauncher({ errorCode: 'EACCES' });
    await expectCliError(fetchCliCommands({ ...base, launcher }), 'cli-spawn-failed');
  });

  it('fails with cli-spawn-failed when the launcher throws', async () => {
    const launcher = () => {
      throw Object.assign(new Error('boom'), { code: 'EINVAL' });
    };
    await expectCliError(fetchCliCommands({ ...base, launcher }), 'cli-spawn-failed');
  });

  it('fails with cli-no-response when stdout has no control_response', async () => {
    const launcher = fakeLauncher({ stdout: 'just text\n' });
    await expectCliError(fetchCliCommands({ ...base, launcher }), 'cli-no-response');
  });

  it('fails with cli-not-found when claude is not on PATH, without launching', async () => {
    const launcher = fakeLauncher();
    await expectCliError(
      fetchCliCommands({ cwd: '/w', env: { PATH: '' }, platform: 'linux', launcher }),
      'cli-not-found',
    );
    expect(launcher.calls).toHaveLength(0);
  });
});
