import { exitQuietlyOnBrokenPipe, runCli } from './cli.js';

exitQuietlyOnBrokenPipe(process.stdout);
exitQuietlyOnBrokenPipe(process.stderr);
process.exitCode = await runCli(process.argv.slice(2));
