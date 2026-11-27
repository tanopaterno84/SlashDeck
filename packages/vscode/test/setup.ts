// Safety net for every test file, as in the core: no test may touch the real user folders.
// The cache and state folders point to a throw-away sandbox, and os.homedir() throws.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, vi } from 'vitest';

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'slashdeck-vscode-test-'));
process.env.SLASHDECK_CACHE_DIR = path.join(sandbox, 'cache');
process.env.SLASHDECK_CONFIG_DIR = path.join(sandbox, 'config');

vi.spyOn(os, 'homedir').mockImplementation(() => {
  throw new Error('a test reached the real home folder');
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
