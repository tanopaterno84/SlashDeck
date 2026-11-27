// Copies the built skill to <repo root>/.claude/skills/slashdeck/, to try it in this
// repository. The copy is build output (ignored by git) and is replaced on every run.
import { cp, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('dist/slashdeck/', import.meta.url));
const target = fileURLToPath(new URL('../../.claude/skills/slashdeck/', import.meta.url));

try {
  await stat(new URL('dist/slashdeck/SKILL.md', import.meta.url));
} catch {
  console.error('install:project: the skill is not built; run `pnpm -r build` first.');
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`install:project: skill copied to ${target}`);
