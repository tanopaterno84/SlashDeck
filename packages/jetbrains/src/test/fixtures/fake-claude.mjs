// A fake Claude Code for the tests: answers the `initialize` control request with invented
// commands, like the real CLI does, and exits. No account data, no model call.
import { createInterface } from 'node:readline';

const commands = [
  { name: 'compact', description: 'Free up context', argumentHint: '<instructions>', builtin: true },
  { name: 'clear', description: 'Start a new session', argumentHint: '', builtin: true },
  { name: 'deploy-check', description: 'Check deploy (cli)', argumentHint: '[env]' },
  { name: 'proj-skill', description: 'Project skill (cli)', argumentHint: '' },
  { name: 'hello', description: 'Say hello (cli)', argumentHint: '' },
];

const rl = createInterface({ input: process.stdin });
rl.once('line', () => {
  const answer = {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'req_1',
      response: { commands, claude_code_version: '9.9.9' },
    },
  };
  process.stdout.write(JSON.stringify(answer) + '\n', () => process.exit(0));
});
