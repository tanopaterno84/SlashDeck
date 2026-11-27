// Safety net for every test file: no test may touch the real user folders.
// - The default cache and state folders point to a throw-away sandbox (library calls that
//   do not pass `env` read process.env).
// - os.homedir() throws, so that code falling back to the real home folder fails loudly
//   instead of writing there (tests must inject `homeDir`).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, vi } from 'vitest';

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'slashdeck-test-sandbox-'));
process.env.SLASHDECK_CACHE_DIR = path.join(sandbox, 'cache');
process.env.SLASHDECK_CONFIG_DIR = path.join(sandbox, 'config');

vi.spyOn(os, 'homedir').mockImplementation(() => {
  throw new Error('a test reached the real home folder: inject homeDir');
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
