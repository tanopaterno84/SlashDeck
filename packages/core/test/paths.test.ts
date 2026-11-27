import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cacheFilePath,
  normalizeWorkspacePath,
  resolveDirs,
  stateFilePath,
  workspaceId,
} from '../src/paths.js';

const home = path.resolve('/home/someone');

describe('resolveDirs', () => {
  it('uses LOCALAPPDATA and APPDATA on Windows', () => {
    const dirs = resolveDirs({
      platform: 'win32',
      homeDir: home,
      env: {
        LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
        APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
      },
    });
    expect(dirs.cacheDir).toBe(path.join('C:\\Users\\x\\AppData\\Local', 'slashdeck'));
    expect(dirs.configDir).toBe(path.join('C:\\Users\\x\\AppData\\Roaming', 'slashdeck'));
  });

  it('falls back to the home folder on Windows without the variables', () => {
    const dirs = resolveDirs({ platform: 'win32', homeDir: home, env: {} });
    expect(dirs.cacheDir).toBe(path.join(home, 'AppData', 'Local', 'slashdeck'));
    expect(dirs.configDir).toBe(path.join(home, 'AppData', 'Roaming', 'slashdeck'));
  });

  it('uses ~/.cache and ~/.config on Linux and macOS', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const dirs = resolveDirs({ platform, homeDir: home, env: {} });
      expect(dirs.cacheDir).toBe(path.join(home, '.cache', 'slashdeck'));
      expect(dirs.configDir).toBe(path.join(home, '.config', 'slashdeck'));
    }
  });

  it('honours absolute XDG variables only', () => {
    const xdg = path.resolve('/xdg');
    const dirs = resolveDirs({
      platform: 'linux',
      homeDir: home,
      env: { XDG_CACHE_HOME: path.join(xdg, 'c'), XDG_CONFIG_HOME: 'relative/config' },
    });
    expect(dirs.cacheDir).toBe(path.join(xdg, 'c', 'slashdeck'));
    expect(dirs.configDir).toBe(path.join(home, '.config', 'slashdeck'));
  });

  it('lets SLASHDECK_CACHE_DIR / SLASHDECK_CONFIG_DIR, then explicit options, win', () => {
    const env = {
      SLASHDECK_CACHE_DIR: path.resolve('/tmp/c'),
      SLASHDECK_CONFIG_DIR: path.resolve('/tmp/s'),
      LOCALAPPDATA: 'C:\\x',
    };
    expect(resolveDirs({ platform: 'win32', homeDir: home, env })).toEqual({
      cacheDir: path.resolve('/tmp/c'),
      configDir: path.resolve('/tmp/s'),
    });
    expect(
      resolveDirs({ platform: 'win32', homeDir: home, env, cacheDir: path.resolve('/o') }).cacheDir,
    ).toBe(path.resolve('/o'));
  });

  it('builds the file paths of CLAUDE.md', () => {
    expect(cacheFilePath('/c', 'abcd')).toBe(path.join('/c', 'workspaces', 'abcd', 'catalog.json'));
    expect(stateFilePath('/s')).toBe(path.join('/s', 'state.json'));
  });
});

describe('workspaceId', () => {
  it('is the first 16 hex characters of the SHA-256 of the normalized path', () => {
    const ws = path.resolve('/repos/project');
    const expected = createHash('sha256')
      .update(normalizeWorkspacePath(ws))
      .digest('hex')
      .slice(0, 16);
    expect(workspaceId(ws)).toBe(expected);
    expect(workspaceId(ws)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ignores case, separators and trailing slashes on Windows only', () => {
    expect(normalizeWorkspacePath('C:\\Repos\\Project\\', 'win32')).toBe(
      normalizeWorkspacePath('c:/repos/project', 'win32'),
    );
    expect(workspaceId('/Repos/Project', 'linux')).not.toBe(workspaceId('/repos/project', 'linux'));
  });
});
