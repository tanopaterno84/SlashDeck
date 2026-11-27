// A fake `claude` for the integration test: the real Claude Code is never started.
//
// - Called like the core's scan (`-p --input-format stream-json ...`): answers the
//   `initialize` request with a synthetic command list (no account data), built like the real
//   CLI does from the built-ins plus the command and skill files of the working folder and of
//   the user folder. Each call is logged to calls.log, next to this script.
// - Called with no arguments (an "interactive session" in a terminal): writes `ready`, then
//   logs every chunk typed into it to input.log as JSON lines; exits on Ctrl+C.
// - Either way, like the real Claude Code, it first rewrites bookkeeping files in the user
//   folder that SlashDeck watches (synced plugins and skills). With SlashDeck 0.1.0 these
//   writes made every scan trigger the next one; the suite checks that they no longer do.
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function names(dir, kind) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => (kind === 'commands' ? d.isFile() && d.name.endsWith('.md') : d.isDirectory()))
      .map((d) => d.name.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

/**
 * What Claude Code 2.x writes when it starts (observed): plugin sync state, an "in use" marker
 * per process, skill staging. Plus folders of kinds SlashDeck does not know, which pass its
 * name filter: only the fingerprint of the definitions can tell that nothing changed.
 * Nothing written here defines a command.
 */
function writeBookkeeping() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const claudeDir = path.join(home, '.claude');
  const stamp = `${process.pid}-${Date.now()}`;
  const group = path.join(claudeDir, 'plugins', 'synced', 'group-it');
  mkdirSync(path.join(group, 'tools~g2', '.in_use'), { recursive: true });
  writeFileSync(path.join(group, '.last-complete-round'), stamp);
  writeFileSync(path.join(group, 'manifest.json'), JSON.stringify({ stamp }));
  writeFileSync(path.join(group, 'tools~g2.meta.json'), JSON.stringify({ stamp }));
  writeFileSync(path.join(group, 'tools~g2', '.in_use', String(process.pid)), stamp);
  mkdirSync(path.join(group, `sync-${stamp}`), { recursive: true });
  const staging = path.join(claudeDir, 'skills', '.staging', stamp);
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, 'SKILL.md'), `---\nname: staged-${stamp}\n---\n`);
  mkdirSync(path.join(claudeDir, 'skills', `tmp-${stamp}`), { recursive: true });
}

try {
  writeBookkeeping();
} catch {
  // Never let the fake fail on its bookkeeping.
}

if (args.includes('-p')) {
  appendFileSync(path.join(here, 'calls.log'), JSON.stringify({ cwd: process.cwd(), args }) + '\n');
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const custom = new Set([
    ...names(path.join(process.cwd(), '.claude', 'commands'), 'commands'),
    ...names(path.join(process.cwd(), '.claude', 'skills'), 'skills'),
    ...names(path.join(home, '.claude', 'commands'), 'commands'),
  ]);
  const commands = [
    {
      name: 'compact',
      description: 'Free up context',
      argumentHint: '<instructions>',
      builtin: true,
    },
    { name: 'clear', description: 'Start a new session', argumentHint: '', builtin: true },
    { name: 'context', description: 'Show the context usage', argumentHint: '', builtin: true },
    { name: 'init', description: 'Create a CLAUDE.md file', argumentHint: '', builtin: true },
    ...[...custom].sort().map((name) => ({ name, description: `${name} (cli)`, argumentHint: '' })),
  ];
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (!input.includes('"initialize"')) return;
    process.stdout.write(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req_1',
          response: { claude_code_version: '9.9.9-fake', commands },
        },
      }) + '\n',
    );
    process.exit(0);
  });
} else {
  const log = path.join(here, 'input.log');
  writeFileSync(log, '');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdout.write('fake claude ready\n');
  writeFileSync(path.join(here, 'ready'), String(process.pid));
  process.stdin.on('data', (chunk) => {
    appendFileSync(log, JSON.stringify(chunk) + '\n');
    if (chunk.includes('\u0003')) process.exit(0);
  });
}
