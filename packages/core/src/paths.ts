/**
 * Where SlashDeck keeps its files (CLAUDE.md, "Modello dati"):
 * - cache: `%LOCALAPPDATA%\slashdeck` on Windows, `$XDG_CACHE_HOME/slashdeck` or
 *   `~/.cache/slashdeck` elsewhere (macOS included); `SLASHDECK_CACHE_DIR` replaces it;
 * - user state: `%APPDATA%\slashdeck` on Windows, `$XDG_CONFIG_HOME/slashdeck` or
 *   `~/.config/slashdeck` elsewhere; `SLASHDECK_CONFIG_DIR` replaces it.
 * The XDG variables are honoured only when they hold an absolute path, as the XDG spec says.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { toPosixPath } from './util.js';

export interface DirOptions {
  /** Explicit cache folder; wins over everything else. */
  cacheDir?: string;
  /** Explicit config (user state) folder; wins over everything else. */
  configDir?: string;
  /** Environment used for SLASHDECK_*, LOCALAPPDATA, APPDATA, XDG_*; default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Home folder used when no variable applies; default os.homedir(). */
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export interface SlashDeckDirs {
  cacheDir: string;
  configDir: string;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

function absoluteEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = envValue(env, name);
  return value !== undefined && path.isAbsolute(value) ? value : undefined;
}

export function resolveDirs(options: DirOptions = {}): SlashDeckDirs {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = () => options.homeDir ?? os.homedir();

  const cacheOverride = options.cacheDir ?? envValue(env, 'SLASHDECK_CACHE_DIR');
  const configOverride = options.configDir ?? envValue(env, 'SLASHDECK_CONFIG_DIR');

  let cacheDir: string;
  let configDir: string;
  if (cacheOverride !== undefined) cacheDir = path.resolve(cacheOverride);
  else if (platform === 'win32')
    cacheDir = path.join(
      envValue(env, 'LOCALAPPDATA') ?? path.join(home(), 'AppData', 'Local'),
      'slashdeck',
    );
  else
    cacheDir = path.join(
      absoluteEnv(env, 'XDG_CACHE_HOME') ?? path.join(home(), '.cache'),
      'slashdeck',
    );

  if (configOverride !== undefined) configDir = path.resolve(configOverride);
  else if (platform === 'win32')
    configDir = path.join(
      envValue(env, 'APPDATA') ?? path.join(home(), 'AppData', 'Roaming'),
      'slashdeck',
    );
  else
    configDir = path.join(
      absoluteEnv(env, 'XDG_CONFIG_HOME') ?? path.join(home(), '.config'),
      'slashdeck',
    );

  return { cacheDir, configDir };
}

/**
 * Normalized absolute workspace path: forward slashes, no trailing slash, and lower case on
 * Windows, whose paths are case-insensitive (`C:\Repo` and `c:/repo` are the same folder).
 */
export function normalizeWorkspacePath(
  workspace: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let p = toPosixPath(path.resolve(workspace));
  if (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);
  return platform === 'win32' ? p.toLowerCase() : p;
}

/** First 16 hex characters of the SHA-256 of the normalized absolute workspace path. */
export function workspaceId(workspace: string, platform: NodeJS.Platform = process.platform) {
  return createHash('sha256')
    .update(normalizeWorkspacePath(workspace, platform))
    .digest('hex')
    .slice(0, 16);
}

export function cacheFilePath(cacheDir: string, id: string): string {
  return path.join(cacheDir, 'workspaces', id, 'catalog.json');
}

export function stateFilePath(configDir: string): string {
  return path.join(configDir, 'state.json');
}
