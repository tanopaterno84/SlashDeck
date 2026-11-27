import os from 'node:os';
import path from 'node:path';
import { loadBuiltinData, type BuiltinData } from './data.js';
import {
  CliSourceError,
  fetchCliCommands,
  type CliResult,
  type Launcher,
} from './discovery/cli-source.js';
import { scanFiles } from './discovery/file-source.js';
import { mergeCatalog } from './discovery/merge.js';
import type { Catalog, ScanWarning } from './types.js';
import { errorMessage, toPosixPath } from './util.js';

export interface ScanOptions {
  workspace: string;
  homeDir?: string;
  /** User config dir; defaults to `<homeDir>/.claude`. */
  claudeDir?: string;
  /** Explicit Claude Code executable. */
  claudePath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  launcher?: Launcher;
  data?: BuiltinData;
  now?: () => Date;
}

export async function scan(options: ScanOptions): Promise<Catalog> {
  const workspace = path.resolve(options.workspace);
  const homeDir = options.homeDir ?? os.homedir();
  const data = options.data ?? loadBuiltinData();
  const warnings: ScanWarning[] = [];

  const cliPromise: Promise<CliResult | null> = fetchCliCommands({
    cwd: workspace,
    ...(options.claudePath !== undefined && { claudePath: options.claudePath }),
    ...(options.env !== undefined && { env: options.env }),
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    ...(options.launcher !== undefined && { launcher: options.launcher }),
  }).catch((err: unknown) => {
    warnings.push({
      code: err instanceof CliSourceError ? err.code : 'cli-failed',
      message: `Claude Code CLI unavailable (${errorMessage(err)}); catalog built from files only.`,
    });
    return null;
  });
  const filesPromise = scanFiles({
    workspace,
    homeDir,
    ...(options.claudeDir !== undefined && { claudeDir: options.claudeDir }),
  });

  const [cli, files] = await Promise.all([cliPromise, filesPromise]);
  const merged = mergeCatalog({ cli, files, data });

  return {
    schemaVersion: 1,
    claudeCodeVersion: merged.claudeCodeVersion,
    source: merged.source,
    workspace: toPosixPath(workspace),
    scannedAt: (options.now?.() ?? new Date()).toISOString(),
    warnings: [...warnings, ...files.warnings, ...merged.warnings],
    commands: merged.commands,
  };
}
