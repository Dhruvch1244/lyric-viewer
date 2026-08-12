'use strict';

/*
  Local developer-CLI fallback (src/main/localcli.js).

  The spawn itself needs a real CLI and would spend the user's tokens, so it is
  not exercised here. What is worth pinning down is everything around it: the
  prompt has to demand bare JSON (the CLIs have no structured-output mode), the
  consent gate has to distinguish "chose one", "declined", and "never asked",
  and the adapters have to build the right command — because a wrong invocation
  fails silently into "all providers failed".
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point Settings at a throwaway file so tests do not touch the real config.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'localcli-'));
process.env.APPDATA = tmpHome;
process.env.XDG_CONFIG_HOME = tmpHome;

const localcli = require('../src/main/localcli');

test('the prompt demands bare JSON and carries the schema', () => {
  const p = localcli.buildPrompt({
    system: 'You fix lyrics.',
    user: 'line one',
    schema: { type: 'object', properties: { lines: { type: 'array' } } },
  });
  assert.match(p, /ONLY a JSON object/i);
  assert.match(p, /You fix lyrics\./);
  assert.match(p, /line one/);
  assert.match(p, /"properties"/); // schema is embedded
  // The "nothing else" reminder is repeated at the end, where a chatty model
  // is most likely to start narrating.
  assert.match(p.slice(-80), /nothing else/i);
});

test('every adapter builds a runnable command', () => {
  for (const a of localcli.ADAPTERS) {
    const { file, args } = a.command('some-model');
    assert.equal(typeof file, 'string');
    assert.ok(file.length > 0, `${a.id} has no command`);
    assert.ok(Array.isArray(args), `${a.id} args not an array`);
  }
});

test('the model-needing adapters put the model in the command', () => {
  const ollama = localcli.ADAPTERS.find((a) => a.id === 'ollama');
  assert.match(ollama.command('llama3.2:latest').args.join(' '), /llama3\.2:latest/);
  const gh = localcli.ADAPTERS.find((a) => a.id === 'copilot');
  assert.match(gh.command('openai/gpt-4o-mini').args.join(' '), /gpt-4o-mini/);
});

test('the requested CLIs are all present, including Antigravity', () => {
  // The user asked for these five specifically.
  const ids = localcli.ADAPTERS.map((a) => a.id);
  for (const id of ['claude', 'gemini', 'ollama', 'copilot', 'antigravity']) {
    assert.ok(ids.includes(id), `missing adapter: ${id}`);
  }
});

/* --- consent state machine --- */

test('a fresh install has not consented and has not decided', () => {
  localcli.setConsent(null);
  const c = localcli.consent();
  assert.equal(c.consented, false);
  assert.equal(c.id, null);
  assert.equal(localcli.isReady(), false);
});

test('choosing a CLI turns it on', () => {
  localcli.setConsent('claude');
  const c = localcli.consent();
  assert.equal(c.consented, true);
  assert.equal(c.id, 'claude');
  assert.equal(localcli.isReady(), true);
});

test('declining is remembered as a decision, distinct from never-asked', () => {
  localcli.setConsent('declined');
  const c = localcli.consent();
  assert.equal(c.consented, false);
  assert.equal(c.id, 'declined'); // so the offer is not shown again
  assert.equal(localcli.isReady(), false);
});

test('an unknown id does not enable anything', () => {
  localcli.setConsent('nonsense-cli');
  assert.equal(localcli.isReady(), false);
  assert.equal(localcli.consent().id, null);
});

test('detect reports every adapter with an installed flag', async () => {
  const found = await localcli.detect();
  assert.equal(found.length, localcli.ADAPTERS.length);
  for (const f of found) {
    assert.equal(typeof f.installed, 'boolean');
    assert.equal(typeof f.install, 'string');
    assert.equal(typeof f.label, 'string');
  }
});
