// Entry point of `pnpm --filter @slashdeck/core dev -- …`. pnpm runs scripts from the package
// folder; INIT_CWD is where pnpm was invoked, so relative paths such as `--workspace .`
// resolve against the folder the user typed the command in.
import { exitQuietlyOnBrokenPipe, runCli } from './cli.js';

if (process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);
exitQuietlyOnBrokenPipe(process.stdout);
exitQuietlyOnBrokenPipe(process.stderr);
process.exitCode = await runCli(process.argv.slice(2));
