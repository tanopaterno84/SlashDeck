/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS module loaded by VS Code */
// Runs inside the test VS Code (see run.mjs). Plain CommonJS, no test framework: each check
// runs in order, failures are collected and make run() reject, which fails the VS Code exit
// code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'slashdeck-placeholder.slashdeck';
const root = process.env.SLASHDECK_IT_ROOT;
const workspace = path.join(root, 'workspace');
const bin = path.join(root, 'bin');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `check` returns a truthy value; throws with `what` after the timeout. */
async function waitFor(what, check, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await check();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what} (last: ${String(last)})`);
}

function calls() {
  try {
    return fs
      .readFileSync(path.join(bin, 'calls.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function inputChunks() {
  try {
    return fs
      .readFileSync(path.join(bin, 'input.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** What another Claude Code (another window, a terminal) writes in the user folder. */
function writeBookkeeping(round) {
  const claudeDir = path.join(root, 'home', '.claude');
  const group = path.join(claudeDir, 'plugins', 'synced', 'group-it');
  fs.mkdirSync(path.join(group, 'other~g2', '.in_use'), { recursive: true });
  fs.writeFileSync(path.join(group, '.last-complete-round'), `suite-${round}`);
  fs.writeFileSync(path.join(group, 'manifest.json'), JSON.stringify({ round }));
  fs.writeFileSync(path.join(group, 'other~g2', '.in_use', String(round)), '');
  fs.mkdirSync(path.join(group, `suite-${round}`), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'skills', '.staging', `suite-${round}`), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'skills', `suite-${round}`), { recursive: true });
}

function group(snapshot, label) {
  return snapshot.groups.find((g) => g.label === label);
}

exports.run = async function run() {
  const results = [];
  let api;

  async function check(name, fn) {
    const started = Date.now();
    try {
      const outcome = await fn();
      results.push({
        name,
        status: outcome === 'skip' ? 'SKIP' : 'PASS',
        ms: Date.now() - started,
      });
    } catch (err) {
      results.push({ name, status: 'FAIL', ms: Date.now() - started, error: err });
    }
  }

  await check('the extension activates', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `${EXTENSION_ID} not found`);
    api = await ext.activate();
    assert.equal(ext.isActive, true);
  });
  if (!api) throw new Error('the extension did not activate');
  // Copy and Run write here instead of the system clipboard of the person running the test.
  const copied = [];
  api.setClipboard({ writeText: async (value) => void copied.push(value) });

  await check('its commands are registered', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    const contributed = ext.packageJSON.contributes.commands.map((c) => c.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.deepEqual(
      contributed.filter((c) => !registered.has(c)),
      [],
    );
    assert.ok(contributed.length >= 13);
  });

  await check('the tree shows the commands of the fixture workspace, project first', async () => {
    await api.idle();
    const snap = await waitFor('a scanned view', () => {
      const s = api.snapshot();
      return s.source === 'cli' && s.groups.length > 0 ? s : null;
    });
    assert.equal(snap.state, 'ready');
    assert.equal(snap.message, undefined);
    assert.deepEqual(
      snap.groups.map((g) => g.label),
      ['Project', 'Personal', 'Session', 'Context', 'Configuration'],
    );
    assert.deepEqual(group(snap, 'Project').commands, ['/deploy-check', '/proj-skill']);
    assert.deepEqual(group(snap, 'Personal').commands, ['/hello']);
    assert.deepEqual(group(snap, 'Context').commands, ['/compact', '/context']);
    assert.equal(snap.badge, 0);
    // The fake Claude Code was asked, in the workspace folder; the real one never was.
    const c = calls();
    assert.ok(c.length >= 1);
    assert.equal(path.resolve(c[0].cwd).toLowerCase(), path.resolve(workspace).toLowerCase());
  });

  await check('after startup the number of scans stops growing', async () => {
    // The fake claude wrote bookkeeping files into the watched user folder during the
    // startup scan, like the real one; here "another Claude Code" keeps writing them. With
    // 0.1.0 each scan triggered the next. An automatic scan would come at most ~12 s after
    // the end of the previous one (1.5 s debounce + 10 s minimum interval): watch for 25 s.
    await api.idle();
    const before = calls().length;
    const end = Date.now() + 25000;
    for (let round = 0; Date.now() < end; round++) {
      writeBookkeeping(round);
      await sleep(2500);
    }
    await api.idle();
    assert.equal(calls().length, before, 'no scan after the startup scan');
    const state = api.refreshState();
    // The writes did reach the watchers: dot-files and manifest.json were dropped by name,
    // the unknown folders were passed on and judged by the fingerprint, which found no
    // change. (0.1.0 scanned on each of these events.)
    assert.ok(state.eventsIgnored > 0, `events dropped by name: ${state.eventsIgnored}`);
    assert.ok(state.eventsAccepted > 0, `events passed on: ${state.eventsAccepted}`);
    assert.ok(state.skippedScans > 0, `scans skipped by the fingerprint: ${state.skippedScans}`);
    assert.equal(state.automaticScans, 0);
    assert.equal(state.streak, 0);
    assert.equal(state.paused, false);
    console.log(
      `  bookkeeping: ${state.eventsIgnored} events dropped by name, ` +
        `${state.eventsAccepted} passed on, ${state.skippedScans} scans skipped, 0 run`,
    );
  });

  await check('pin and unpin move a command in and out of Favourites', async () => {
    await vscode.commands.executeCommand('slashdeck.pin', '/deploy-check');
    let snap = api.snapshot();
    assert.equal(snap.groups[0].label, 'Favourites');
    assert.deepEqual(snap.groups[0].commands, ['/deploy-check']);
    assert.ok(
      fs.existsSync(path.join(root, 'config', 'state.json')),
      'state.json in the temp folder',
    );
    await vscode.commands.executeCommand('slashdeck.unpin', '/deploy-check');
    snap = api.snapshot();
    assert.equal(snap.groups[0].label, 'Project');
  });

  await check('a new command file is picked up by the watcher and marked as new', async () => {
    const before = calls().length;
    fs.writeFileSync(
      path.join(workspace, '.claude', 'commands', 'new-thing.md'),
      '---\ndescription: A command added while VS Code runs\n---\nDo it.\n',
    );
    const snap = await waitFor('/new-thing in the tree', () => {
      const s = api.snapshot();
      return group(s, 'Project')?.commands.includes('/new-thing') ? s : null;
    });
    assert.equal(snap.badge, 1);
    assert.ok(calls().length > before, 'a new scan ran');
    // That scan wrote bookkeeping files again: still exactly one scan.
    await sleep(15000);
    await api.idle();
    assert.equal(calls().length, before + 1, 'exactly one scan for one new command');
    assert.equal(api.refreshState().automaticScans, 1);
  });

  await check('a team override change reloads the view without a scan', async () => {
    await api.idle();
    const before = calls().length;
    fs.writeFileSync(
      path.join(workspace, '.claude', 'slashdeck.json'),
      JSON.stringify({ schemaVersion: 1, commands: { '/hello': { category: 'project' } } }),
    );
    await waitFor('/hello in Project', () =>
      group(api.snapshot(), 'Project')?.commands.includes('/hello'),
    );
    await sleep(500);
    assert.equal(calls().length, before, 'no scan for a team override change');
  });

  await check(
    'Run without a Claude Code terminal copies and never creates a terminal',
    async () => {
      const terminals = vscode.window.terminals.length;
      assert.equal(api.claudeTerminalCount(), 0);
      await vscode.commands.executeCommand('slashdeck.run', '/clear');
      assert.equal(vscode.window.terminals.length, terminals);
      assert.deepEqual(copied.splice(0), ['/clear']);
    },
  );

  await check('Copy puts the command on the clipboard', async () => {
    await vscode.commands.executeCommand('slashdeck.copy', '/proj-skill');
    assert.deepEqual(copied.splice(0), ['/proj-skill']);
  });

  await check('a claude started in a terminal is detected and Run types into it', async () => {
    // Real shell integration of the default shell of the test VS Code.
    const terminal = vscode.window.createTerminal({ name: 'claude test' });
    terminal.show();
    try {
      const integration = await waitFor(
        'shell integration',
        () => terminal.shellIntegration,
        30000,
      ).catch(() => undefined);
      if (!integration) {
        console.log('  shell integration did not activate in the test terminal: check skipped');
        return 'skip';
      }
      const fake = process.env.SLASHDECK_IT_FAKE_CLAUDE;
      const commandLine = process.platform === 'win32' ? `& '${fake}'` : `'${fake}'`;
      integration.executeCommand(commandLine);
      await waitFor('the claude terminal to be detected', () => api.claudeTerminalCount() === 1);
      await waitFor('the fake claude to start', () => fs.existsSync(path.join(bin, 'ready')));

      await vscode.commands.executeCommand('slashdeck.run', '/clear');
      await waitFor('"/clear" then Enter', () => {
        const typed = inputChunks().join('');
        return typed.includes('/clear') && typed.endsWith('\r');
      });

      // A command with arguments is typed with a space and not submitted.
      await vscode.commands.executeCommand('slashdeck.run', '/compact');
      await waitFor('"/compact "', () => inputChunks().join('').endsWith('/compact '));
      await sleep(1000);
      assert.ok(inputChunks().join('').endsWith('/compact '), 'no Enter after /compact');

      terminal.sendText('\u0003', false);
      await waitFor('the end of the claude execution', () => api.claudeTerminalCount() === 0);
    } finally {
      terminal.dispose();
    }
  });

  await check('fallback mode: Claude Code not found, built-in commands missing', async () => {
    const config = vscode.workspace.getConfiguration('slashdeck');
    await config.update(
      'claudePath',
      path.join(root, 'missing', process.platform === 'win32' ? 'claude.exe' : 'claude'),
      vscode.ConfigurationTarget.Global,
    );
    try {
      const snap = await waitFor('the fallback view', async () => {
        await api.idle();
        const s = api.snapshot();
        return s.source === 'files' ? s : null;
      });
      assert.match(snap.message, /built-in commands are missing/);
      assert.match(snap.message, /slashdeck\.claudePath/);
      assert.equal(group(snap, 'Session'), undefined);
      assert.ok(group(snap, 'Project').commands.includes('/deploy-check'));
    } finally {
      await config.update('claudePath', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  console.log('\nSlashDeck integration test');
  for (const r of results) {
    console.log(`  ${r.status} ${r.name} (${r.ms} ms)`);
    if (r.error)
      console.log(`       ${String(r.error && r.error.stack ? r.error.stack : r.error)}`);
  }
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(
    `  ${results.length} checks: ${results.filter((r) => r.status === 'PASS').length} passed, ` +
      `${results.filter((r) => r.status === 'SKIP').length} skipped, ${failed} failed\n`,
  );
  if (failed > 0) throw new Error(`${failed} integration check(s) failed`);
};
