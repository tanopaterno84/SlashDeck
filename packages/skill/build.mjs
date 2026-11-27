// Assembles the ready-to-copy skill folder:
//   dist/slashdeck/SKILL.md
//   dist/slashdeck/scripts/slashdeck.mjs   (the self-contained core CLI)
// The CLI is built by @slashdeck/core (`pnpm -r build` builds the core first).
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const cli = here('../core/dist/slashdeck.mjs');
const out = here('dist/slashdeck/');

try {
  await stat(cli);
} catch {
  console.error(`skill build: ${cli} not found; build @slashdeck/core first (pnpm -r build).`);
  process.exit(1);
}

await rm(here('dist/'), { recursive: true, force: true });
await mkdir(here('dist/slashdeck/scripts/'), { recursive: true });
await copyFile(here('src/SKILL.md'), here('dist/slashdeck/SKILL.md'));
await copyFile(cli, here('dist/slashdeck/scripts/slashdeck.mjs'));
console.log(`skill build: ${out}`);
