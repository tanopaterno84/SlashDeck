// Bundles the extension with esbuild into one CommonJS file, dist/extension.cjs: the core
// and its dependencies (zod, yaml) are included, `vscode` is provided by VS Code.
// CommonJS because the minimum supported VS Code (1.93) does not load ESM extensions.
//
//   node build.mjs               development build, with a source map
//   node build.mjs --production  what goes into the .vsix: no source map, whitespace and
//                                syntax minified (names kept, for readable stack traces)
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const production = process.argv.includes('--production');

await rm(new URL('./dist', import.meta.url), { recursive: true, force: true });

await build({
  // Relative paths below (and in the source map) are relative to this folder.
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // Node shipped with VS Code 1.93.
  target: 'node20',
  external: ['vscode'],
  // The core's sources, not its build output: one bundle step, and the build of the
  // extension does not depend on the order of the workspace builds.
  alias: { '@slashdeck/core': './../core/src/index.ts' },
  sourcemap: production ? false : 'linked',
  minifyWhitespace: production,
  minifySyntax: production,
  legalComments: 'eof',
  logLevel: 'info',
});
