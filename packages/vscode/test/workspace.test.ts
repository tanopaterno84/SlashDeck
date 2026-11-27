import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseTarget, userClaudeDir, viewStatus, watchSpecs } from '../src/workspace.js';
import { en, entry, view } from './helpers.js';

const HOME = path.resolve('/home/me');

describe('chooseTarget', () => {
  const a = { name: 'a', path: path.resolve('/repos/a') };
  const b = { name: 'b', path: path.resolve('/repos/b') };

  it('uses the home folder when no folder is open', () => {
    expect(chooseTarget([], undefined, HOME)).toEqual({ path: HOME, label: '', noFolder: true });
  });

  it('uses the only folder, without a label', () => {
    expect(chooseTarget([a], b.path, HOME)).toEqual({ path: a.path, label: '', noFolder: false });
  });

  it('uses the remembered folder of a multi-root workspace, else the first', () => {
    expect(chooseTarget([a, b], b.path, HOME)).toEqual({
      path: b.path,
      label: 'b',
      noFolder: false,
    });
    expect(chooseTarget([a, b], undefined, HOME)).toEqual({
      path: a.path,
      label: 'a',
      noFolder: false,
    });
    expect(chooseTarget([a, b], path.resolve('/gone'), HOME).path).toBe(a.path);
  });
});

describe('userClaudeDir', () => {
  it('honours CLAUDE_CONFIG_DIR like the core CLI', () => {
    expect(userClaudeDir({}, HOME)).toBe(path.join(HOME, '.claude'));
    expect(userClaudeDir({ CLAUDE_CONFIG_DIR: ' ' }, HOME)).toBe(path.join(HOME, '.claude'));
    expect(userClaudeDir({ CLAUDE_CONFIG_DIR: path.resolve('/cfg') }, HOME)).toBe(
      path.resolve('/cfg'),
    );
  });
});

describe('watchSpecs', () => {
  const claudeDir = path.join(HOME, '.claude');
  const configDir = path.resolve('/config/slashdeck');

  it('watches the workspace and the user folders', () => {
    const target = { path: path.resolve('/repos/a'), label: '', noFolder: false };
    const specs = watchSpecs(target, claudeDir, configDir);
    expect(specs).toContainEqual({
      base: target.path,
      glob: '.claude/{commands,skills}/**',
      effect: 'scan',
      area: 'project',
    });
    // The team override is applied when reading: a reload is enough.
    expect(specs).toContainEqual({
      base: target.path,
      glob: '.claude/slashdeck.json',
      effect: 'reload',
      area: 'file',
    });
    expect(specs).toContainEqual({
      base: path.join(claudeDir, 'commands'),
      glob: '**',
      effect: 'scan',
      area: 'commands',
    });
    expect(specs).toContainEqual({
      base: path.join(claudeDir, 'skills'),
      glob: '**',
      effect: 'scan',
      area: 'skills',
    });
    expect(specs).toContainEqual({
      base: claudeDir,
      glob: '{commands,skills}',
      effect: 'scan',
      area: 'roots',
      rewatch: true,
    });
    expect(specs).toContainEqual({
      base: path.join(claudeDir, 'plugins'),
      glob: '{installed_plugins.json,synced/**}',
      effect: 'scan',
      area: 'plugins',
    });
    expect(specs).toContainEqual({
      base: configDir,
      glob: 'state.json',
      effect: 'reload',
      area: 'file',
    });
  });

  it('does not watch the home folder as a workspace when no folder is open', () => {
    const specs = watchSpecs({ path: HOME, label: '', noFolder: true }, claudeDir, configDir);
    expect(specs.some((s) => s.base === HOME)).toBe(false);
  });
});

describe('viewStatus', () => {
  const base = { scanning: false, scanError: null, trusted: true, noFolder: false };
  const one = view([entry('/a')]);

  it('is loading until there is a view, or failed when the first scan failed', () => {
    expect(viewStatus({ ...base, view: null, scanning: true }, en).state).toBe('loading');
    expect(viewStatus({ ...base, view: null }, en).state).toBe('loading');
    expect(viewStatus({ ...base, view: null, scanError: 'boom' }, en).state).toBe('error');
    expect(viewStatus({ ...base, view: null, scanError: 'boom', scanning: true }, en).state).toBe(
      'loading',
    );
  });

  it('is empty without commands, ready with some', () => {
    expect(viewStatus({ ...base, view: view([]) }, en)).toEqual({
      state: 'empty',
      message: undefined,
    });
    expect(viewStatus({ ...base, view: one }, en)).toEqual({ state: 'ready', message: undefined });
  });

  it('explains the fallback mode, and how to fix a missing Claude Code', () => {
    const files = view([entry('/a')], {
      source: 'files',
      warnings: [{ code: 'cli-not-found', message: 'not found' }],
    });
    const status = viewStatus({ ...base, view: files }, en);
    expect(status.message).toContain('built-in commands are missing');
    expect(status.message).toContain('slashdeck.claudePath');
    const timeout = view([entry('/a')], {
      source: 'files',
      warnings: [{ code: 'cli-timeout', message: 'slow' }],
    });
    expect(viewStatus({ ...base, view: timeout }, en).message).not.toContain('claudePath');
  });

  it('explains Restricted Mode, no folder and a failed refresh', () => {
    const files = view([entry('/a')], { source: 'files' });
    expect(viewStatus({ ...base, view: files, trusted: false }, en).message).toMatch(
      /^Restricted Mode/,
    );
    expect(viewStatus({ ...base, view: one, noFolder: true }, en).message).toContain(
      'No folder open',
    );
    expect(viewStatus({ ...base, view: one, scanError: 'boom' }, en).message).toContain(
      'The last refresh failed',
    );
  });

  it('keeps the list visible while a background refresh runs', () => {
    expect(viewStatus({ ...base, view: one, scanning: true }, en)).toEqual({
      state: 'ready',
      message: undefined,
    });
  });

  it('says when the automatic refresh is paused', () => {
    expect(viewStatus({ ...base, view: one, autoRefreshPaused: true }, en).message).toContain(
      'Automatic refresh is paused',
    );
  });
});
