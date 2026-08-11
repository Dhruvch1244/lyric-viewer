'use strict';

/*
  The MilkDrop preset corpus (src/main/presetlib.js).

  Two things are worth pinning down. The first is that a broken corpus degrades
  rather than throws: this runs inside an IPC handler on the main process, so an
  unhandled read error is a rejected promise in the renderer's preset switch,
  and the visuals stop changing with nothing on screen to say why. The second is
  that the names `presets.js` hardcodes still resolve — those are the starting
  points for the MilkDrop looks, and a corpus regeneration that renamed one
  would leave a look permanently drawing the fallback.
*/

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PresetLibrary, ThumbnailStore, CACHE_MAX } = require('../src/main/presetlib');

/** Build a throwaway corpus on disk. */
function fixture(presets, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presets-'));
  const index = presets.map((p, i) => ({ name: p.name, file: `${i}.json` }));
  fs.writeFileSync(path.join(dir, 'index.json'),
    JSON.stringify({ version: 1, count: index.length, presets: index }));
  presets.forEach((p, i) => {
    fs.writeFileSync(path.join(dir, `${i}.json`),
      p.raw !== undefined ? p.raw : JSON.stringify(p.body || { baseVals: {} }));
  });
  Object.entries(extra).forEach(([f, body]) => fs.writeFileSync(path.join(dir, f), body));
  return dir;
}

test('names come back sorted, and presets parse', () => {
  const dir = fixture([
    { name: 'zeta', body: { baseVals: { zoom: 1 } } },
    { name: 'alpha', body: { baseVals: { zoom: 2 } } },
  ]);
  const lib = new PresetLibrary(dir);

  assert.deepEqual(lib.names(), ['alpha', 'zeta']);
  assert.deepEqual(lib.get('alpha'), { baseVals: { zoom: 2 } });
});

test('an unknown name is null, not a throw', () => {
  // A pin persisted against an older corpus is exactly this case, and it must
  // not take the preset switch down with it.
  const lib = new PresetLibrary(fixture([{ name: 'alpha' }]));
  assert.equal(lib.get('nothing here'), null);
  assert.equal(lib.get(''), null);
  assert.equal(lib.get(undefined), null);
});

test('a missing corpus degrades to an empty catalogue', () => {
  // The frame ships a resident pack precisely so this costs variety, not
  // visuals. What it must not do is throw inside the IPC handler.
  const lib = new PresetLibrary(path.join(os.tmpdir(), 'no-such-corpus-dir'));
  assert.deepEqual(lib.names(), []);
  assert.equal(lib.get('alpha'), null);
  assert.equal(lib.failed, true);
});

test('a corrupt index degrades the same way, and is not retried', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presets-'));
  fs.writeFileSync(path.join(dir, 'index.json'), '{ not json');
  const lib = new PresetLibrary(dir);
  assert.deepEqual(lib.names(), []);
  assert.equal(lib.failed, true);
  // Second call must not re-read: this runs per click in the browser.
  assert.deepEqual(lib.names(), []);
});

test('a corrupt preset file is null, and the rest still work', () => {
  const dir = fixture([
    { name: 'broken', raw: '{ truncated' },
    { name: 'fine', body: { baseVals: { zoom: 1 } } },
  ]);
  const lib = new PresetLibrary(dir);
  assert.equal(lib.get('broken'), null);
  assert.deepEqual(lib.get('fine'), { baseVals: { zoom: 1 } });
});

test('a repeat request is served from cache, not re-read', () => {
  const dir = fixture([{ name: 'alpha', body: { baseVals: { zoom: 1 } } }]);
  const lib = new PresetLibrary(dir);
  const first = lib.get('alpha');

  // Delete the file underneath it. A cached hit still answers; a re-read
  // could not.
  fs.rmSync(path.join(dir, '0.json'));
  assert.equal(lib.get('alpha'), first);
});

test('the cache is bounded, and evicts least-recently-used', () => {
  const many = [];
  for (let i = 0; i < CACHE_MAX + 10; i += 1) many.push({ name: `p${i}`, body: { i } });
  const lib = new PresetLibrary(fixture(many));

  lib.get('p0');
  for (let i = 1; i < CACHE_MAX; i += 1) lib.get(`p${i}`);
  // Touch p0 so it is the most recent, then overflow by one.
  lib.get('p0');
  lib.get(`p${CACHE_MAX}`);

  assert.equal(lib.cache.size, CACHE_MAX);
  assert.ok(lib.cache.has('p0'), 'the most recently used entry was evicted');
  assert.ok(!lib.cache.has('p1'), 'the least recently used entry survived');
});

/* --- against the corpus that actually ships --- */

test('the shipped corpus holds every preset a visual look names', () => {
  const lib = new PresetLibrary();
  const names = new Set(lib.names());
  assert.ok(names.size > 1000, `corpus looks wrong: ${names.size} presets`);

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'presets.js'), 'utf8',
  );
  const named = [...source.matchAll(/milkdrop:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(named.length > 0, 'no milkdrop looks found to check');

  for (const name of named) {
    assert.ok(names.has(name),
      `presets.js starts a look on "${name}", which the corpus does not hold`);
  }
});

/* --- the preview cache --- */

test('a preview round-trips through disk unchanged', () => {
  // The point of the cache is that a second open of the browser paints from
  // disk instead of re-rendering 1754 presets on the GPU.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-')), 'preset-thumbs');
  const store = new ThumbnailStore(dir);
  const url = `data:image/jpeg;base64,${Buffer.from('not really a jpeg').toString('base64')}`;

  assert.equal(store.get('Flexi - alien fish pond'), null);
  assert.equal(store.put('Flexi - alien fish pond', url), true);
  assert.equal(store.get('Flexi - alien fish pond'), url);
});

test('preset names with path characters do not become paths', () => {
  // Real catalogue entries include `$$$ Royal - Mashup (160)` and names with
  // slashes and quotes. The filename is a hash for exactly this reason.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-')), 'preset-thumbs');
  const store = new ThumbnailStore(dir);
  const nasty = '../../escape/attempt "quoted" <angle> |pipe|';
  const url = `data:image/jpeg;base64,${Buffer.from('x').toString('base64')}`;

  assert.equal(store.put(nasty, url), true);
  assert.equal(store.get(nasty), url);
  assert.equal(path.dirname(store.pathFor(nasty)), dir, 'wrote outside its directory');
  assert.match(path.basename(store.pathFor(nasty)), /^[0-9a-f]{16}\.jpg$/);
});

test('anything that is not a JPEG data URL is refused', () => {
  // This value comes from the renderer. A wrong one should be dropped here
  // rather than written and then handed back as a broken <img>.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-')), 'preset-thumbs');
  const store = new ThumbnailStore(dir);
  for (const bad of ['', 'https://example.com/x.jpg', 'data:image/png;base64,AAAA', null, 42]) {
    assert.equal(store.put('alpha', bad), false, `accepted ${String(bad)}`);
  }
  assert.equal(store.get('alpha'), null);
});

test('clear throws the previews away', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-')), 'preset-thumbs');
  const store = new ThumbnailStore(dir);
  const url = `data:image/jpeg;base64,${Buffer.from('x').toString('base64')}`;
  store.put('alpha', url);
  assert.equal(store.clear(), true);
  assert.equal(store.get('alpha'), null);
  // ...and the store still works afterwards, rather than needing a restart.
  assert.equal(store.put('alpha', url), true);
  assert.equal(store.get('alpha'), url);
});

test('every shipped preset actually parses', () => {
  // scripts/vendor-presets.js parses at build time for exactly this reason: a
  // preset that throws does so inside the render loop, where the recovery path
  // steps to the next one every frame forever.
  const lib = new PresetLibrary();
  for (const name of lib.names()) {
    assert.notEqual(lib.get(name), null, `${name} did not parse`);
  }
});
