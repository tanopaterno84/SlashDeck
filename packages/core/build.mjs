// Bundles the core with esbuild. JSON imports (data/builtin-commands.json) are inlined,
// so the built output never looks the data file up at runtime.
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await rm(new URL('./dist', import.meta.url), { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' });
await build({
  ...common,
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node' },
});

// Self-contained CLI in one file, dependencies included: it runs with plain `node` and no
// node_modules. Shipped inside the help skill (packages/skill), which copies it from here.
// `yaml` is CommonJS on Node
// and calls require() for Node built-ins, so the banner gives the ESM bundle a real require.
await build({
  ...common,
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/slashdeck.mjs',
  // Colleagues may have an older Node than the development one.
  target: 'node20',
  packages: 'bundle',
  sourcemap: false,
  minify: true,
  legalComments: 'eof',
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __slashdeckCreateRequire } from 'node:module';",
      'const require = __slashdeckCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
