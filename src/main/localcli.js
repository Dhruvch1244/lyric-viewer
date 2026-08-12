'use strict';

const { spawn, execFile } = require('child_process');
const { Settings } = require('./settings');
const { parseJsonLoose } = require('./llm');

/**
 * Local developer-CLI fallback for the LLM layer.
 *
 * WHY. The four cloud providers all fail the same way in practice: a free
 * Gemini quota runs out, an HF token lacks a scope, a key is revoked. When they
 * all miss, every AI feature — translation, transliteration, mood, transcript
 * correction, per-line artist attribution — dies, even on a developer's machine
 * that has a perfectly good model a shell command away. Many devs have exactly
 * that: the Claude, Gemini, Ollama or GitHub CLIs installed and logged in. This
 * uses one of them as the last link in the chain.
 *
 * CONSENT IS REQUIRED, ALWAYS. Shelling out to someone's CLI runs their tools
 * and can spend their tokens, so this never happens silently: it stays dormant
 * until the user explicitly picks a CLI (see `setConsent`). Until then
 * `isReady()` is false and llm.js does not even offer it.
 *
 * BEST-EFFORT BY DESIGN. These are third-party CLIs whose non-interactive
 * contracts are not all stable or documented — Antigravity in particular. Every
 * adapter runs with a timeout and, on any failure, returns nothing so the
 * caller reports "all providers failed" exactly as before. A fallback that
 * hangs or throws would be worse than no fallback.
 */

/** How long to wait for a one-shot CLI call before giving up. */
const RUN_TIMEOUT_MS = 90_000;
/** How long a detection probe may take. */
const DETECT_TIMEOUT_MS = 4_000;

/**
 * The CLIs this knows how to drive, in preference order.
 *
 * Each adapter says how to check it is installed (`probe`) and how to build the
 * spawn for a one-shot prompt (`command`). The prompt always goes in on stdin,
 * never as an argument: lyric batches run to thousands of characters and a
 * command line has a hard length limit on Windows.
 */
const ADAPTERS = [
  {
    id: 'claude',
    label: 'Claude CLI',
    cmd: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    // `-p` is print / non-interactive: read stdin, print the reply, exit.
    // Verified end to end: returns and parses JSON.
    verified: true,
    command: () => ({ file: 'claude', args: ['-p'] }),
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    cmd: 'gemini',
    install: 'npm install -g @google/gemini-cli',
    /*
      NOT `-p`: that flag REQUIRES the prompt as its value ("not enough
      arguments following: -p"), and our prompts are multi-line JSON that cannot
      be passed as a Windows command-line argument — cmd.exe (which shell:true
      routes through, needed for the .cmd shim) caps args near 8KB and mangles
      newlines and quotes. So it is run bare and fed the prompt on stdin, and
      relies on Gemini reading piped (non-TTY) input. Best-effort: if a build
      insists on interactive mode it times out and the chain moves on.
    */
    command: () => ({ file: 'gemini', args: [] }),
  },
  {
    id: 'ollama',
    label: 'Ollama (fully local)',
    cmd: 'ollama',
    install: 'https://ollama.com/download',
    // `ollama run <model>` reads the prompt on stdin. The model is discovered
    // at call time so this works with whatever the user has pulled.
    needsModel: 'ollama',
    command: (model) => ({ file: 'ollama', args: ['run', model || 'llama3.2'] }),
  },
  {
    id: 'copilot',
    label: 'GitHub Models (gh)',
    cmd: 'gh',
    install: 'gh extension install github/gh-models',
    // Copilot's own CLI only suggests shell commands; the gh-models extension
    // is the one that runs a chat model non-interactively, reading stdin.
    needsModel: 'gh',
    command: (model) => ({ file: 'gh', args: ['models', 'run', model || 'openai/gpt-4o-mini'] }),
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    cmd: 'antigravity',
    install: 'https://antigravity.google/',
    // Antigravity is primarily an IDE; its non-interactive contract is not
    // documented, so this is a best guess and is marked experimental in the UI.
    unverified: true,
    command: () => ({ file: 'antigravity', args: [] }),
  },
];

const settings = new Settings();

/** @returns {{consented: boolean, id: string|null}} */
function consent() {
  const raw = settings.get('localCli', null);
  if (raw && typeof raw === 'object') {
    return { consented: Boolean(raw.consented), id: raw.id || null };
  }
  return { consented: false, id: null };
}

/**
 * Record the user's choice.
 *
 * A known adapter id turns it on. The literal 'declined' is stored as a real
 * decision so the offer is not shown again — distinct from "never asked", which
 * is what an absent setting means. Anything else clears it.
 *
 * @param {string|null} id an adapter id, 'declined', or null to reset
 */
function setConsent(id) {
  if (id === 'declined') {
    settings.set('localCli', { consented: false, id: 'declined' });
    return;
  }
  const known = ADAPTERS.some((a) => a.id === id);
  settings.set('localCli', { consented: known, id: known ? id : null });
}

/** Whether a consented CLI is selected and thus usable. */
function isReady() {
  const c = consent();
  return c.consented && Boolean(c.id);
}

/** The chosen adapter, or null. */
function chosenAdapter() {
  const c = consent();
  return c.consented ? ADAPTERS.find((a) => a.id === c.id) || null : null;
}

/**
 * Is a command on PATH? Uses `where` on Windows, `which` elsewhere.
 * @param {string} cmd
 * @returns {Promise<boolean>}
 */
function onPath(cmd) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFile(finder, [cmd], { timeout: DETECT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(!err && Boolean((stdout || '').trim()));
    });
  });
}

/**
 * Which of the known CLIs are installed right now.
 *
 * Reports every adapter with an `installed` flag rather than only the installed
 * ones, so the UI can offer to install a missing one (see `install`).
 *
 * @returns {Promise<Array<{id: string, label: string, installed: boolean,
 *   install: string, unverified: boolean}>>}
 */
async function detect() {
  const results = await Promise.all(ADAPTERS.map(async (a) => ({
    id: a.id,
    label: a.label,
    installed: await onPath(a.cmd),
    install: a.install,
    unverified: Boolean(a.unverified),
    verified: Boolean(a.verified),
  })));
  return results;
}

/**
 * Discover a usable model name for adapters that need one.
 * @param {'ollama'|'gh'} kind
 * @returns {Promise<string|null>}
 */
function discoverModel(kind) {
  return new Promise((resolve) => {
    if (kind === 'ollama') {
      execFile('ollama', ['list'], { timeout: DETECT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        // First data row, first column, is a model tag like "llama3.2:latest".
        const lines = (stdout || '').trim().split('\n').slice(1);
        const first = lines[0] && lines[0].trim().split(/\s+/)[0];
        return resolve(first || null);
      });
      return;
    }
    // gh-models: no cheap list parse worth the round trip; use a sensible default.
    resolve(null);
  });
}

/**
 * Build the single prompt string sent to a CLI.
 *
 * The CLIs have no structured-output mode, so — exactly like the Groq and HF
 * adapters in llm.js — the schema is described in the prompt and the call sites
 * validate the shape. The instruction to emit ONLY JSON is stated twice, top
 * and bottom, because a chatty model otherwise wraps it in prose.
 *
 * @param {{system: string, user: string, schema: object}} args
 * @returns {string}
 */
function buildPrompt({ system, user, schema }) {
  return `${system}

Respond with ONLY a JSON object conforming to this JSON Schema. No markdown, no
code fence, no commentary — just the JSON.

Schema:
${JSON.stringify(schema)}

Input:
${user}

Remember: output the JSON object and nothing else.`;
}

/**
 * Run the chosen CLI once and return the parsed JSON.
 *
 * Matches the `call` signature the llm.js chain expects, so it slots in as one
 * more provider. Throws on any failure — no CLI chosen, not installed, timed
 * out, non-zero exit, unparseable output — which is what makes the chain move
 * on and ultimately report that every provider failed.
 *
 * @param {{system: string, user: string, schema: object}} args
 * @returns {Promise<object>}
 */
async function call({ system, user, schema }) {
  const adapter = chosenAdapter();
  if (!adapter) throw new Error('no local CLI selected');

  let model = null;
  if (adapter.needsModel) {
    model = await discoverModel(adapter.needsModel);
    if (adapter.needsModel === 'ollama' && !model) {
      throw new Error('ollama has no models pulled (try: ollama pull llama3.2)');
    }
  }

  const { file, args } = adapter.command(model);
  const prompt = buildPrompt({ system, user, schema });

  const stdout = await new Promise((resolve, reject) => {
    let child;
    try {
      /*
        `shell: true` on Windows, because these CLIs install as `.cmd`/`.ps1`
        shims (npm global bins, gh) that `spawn` cannot execute directly —
        measured: a bare `spawn('claude', …)` fails with ENOENT even though the
        command is on PATH. The prompt goes on stdin, never in `args`, so the
        shell has nothing user-supplied to mis-split; the args are fixed
        literals plus a model tag from `ollama list`.
      */
      child = spawn(file, args, { windowsHide: true, shell: process.platform === 'win32' });
    } catch (err) {
      reject(new Error(`${adapter.id}: could not start (${err.message})`));
      return;
    }

    let out = '';
    let errText = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${adapter.id}: timed out after ${RUN_TIMEOUT_MS / 1000}s`));
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errText += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${adapter.id}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${adapter.id}: exited ${code} ${errText.slice(0, 160)}`.trim()));
      } else {
        resolve(out);
      }
    });

    // Prompt on stdin: too long for a command-line argument on Windows.
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      reject(new Error(`${adapter.id}: could not write prompt (${err.message})`));
    }
  });

  return parseJsonLoose(stdout);
}

module.exports = {
  detect, setConsent, consent, isReady, call, buildPrompt, ADAPTERS,
};
