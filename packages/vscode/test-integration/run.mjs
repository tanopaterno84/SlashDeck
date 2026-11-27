// Integration test: starts a real VS Code (downloaded by @vscode/test-electron into
// .vscode-test/) with the extension loaded, and runs suite.cjs inside it.
//
// Isolation: every folder the test VS Code and the extension use is a fresh temp folder:
// user data, extensions, home (USERPROFILE/HOME, so ~/.claude and ~/.vscode are fake),
// SlashDeck's cache and state. Claude Code is a fake (fake-claude.mjs), set both with
// SLASHDECK_CLAUDE_PATH and first on the PATH: the real `claude` is never started.
//
// Run after `node build.mjs`: pnpm --filter slashdeck test:integration
import { runTests } from '@vscode/test-electron';
import { chmod, copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..');
const fixtures = path.join(extensionRoot, 'test', 'fixtures');

const root = await mkdtemp(path.join(tmpdir(), 'slashdeck-it-'));
const dirs = {
  workspace: path.join(root, 'workspace'),
  home: path.join(root, 'home'),
  bin: path.join(root, 'bin'),
  userData: path.join(root, 'user-data'),
  extensions: path.join(root, 'extensions'),
  cache: path.join(root, 'cache'),
  config: path.join(root, 'config'),
};

let exitCode = 1;
try {
  await cp(path.join(fixtures, 'workspace'), dirs.workspace, { recursive: true });
  await cp(path.join(fixtures, 'home'), dirs.home, { recursive: true });
  // The user folders the watchers watch exist from the start, as on a real machine; the fake
  // claude writes its bookkeeping files there.
  await mkdir(path.join(dirs.home, '.claude', 'skills'), { recursive: true });
  await mkdir(path.join(dirs.home, '.claude', 'plugins', 'synced', 'group-it'), {
    recursive: true,
  });
  await mkdir(dirs.bin, { recursive: true });
  await copyFile(path.join(here, 'fake-claude.mjs'), path.join(dirs.bin, 'fake-claude.mjs'));
  const script = path.join(dirs.bin, 'fake-claude.mjs');
  let fakeClaude;
  if (process.platform === 'win32') {
    fakeClaude = path.join(dirs.bin, 'claude.cmd');
    await writeFile(fakeClaude, `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    fakeClaude = path.join(dirs.bin, 'claude');
    await writeFile(fakeClaude, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(fakeClaude, 0o755);
  }

  const env = {
    SLASHDECK_CACHE_DIR: dirs.cache,
    SLASHDECK_CONFIG_DIR: dirs.config,
    SLASHDECK_CLAUDE_PATH: fakeClaude,
    // ~/.claude and ~/.vscode of the test instance are in the temp folder.
    USERPROFILE: dirs.home,
    HOME: dirs.home,
    CLAUDE_CONFIG_DIR: '',
    PATH: `${dirs.bin}${path.delimiter}${process.env.PATH ?? ''}`,
    // Read by suite.cjs.
    SLASHDECK_IT_ROOT: root,
    SLASHDECK_IT_FAKE_CLAUDE: fakeClaude,
  };
  // Windows env names are case-insensitive: drop a "Path" that would shadow PATH.
  for (const key of Object.keys(process.env)) {
    if (key !== 'PATH' && key.toUpperCase() === 'PATH') env[key] = env.PATH;
  }

  exitCode = await runTests({
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(here, 'suite.cjs'),
    extensionTestsEnv: env,
    launchArgs: [
      dirs.workspace,
      `--user-data-dir=${dirs.userData}`,
      `--extensions-dir=${dirs.extensions}`,
      '--disable-extensions',
      '--disable-telemetry',
    ],
  });
} catch (err) {
  console.error(`integration test failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {
    console.error(`could not remove ${root}`);
  });
}
process.exit(exitCode);
