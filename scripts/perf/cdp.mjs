/*
  A minimal Chrome DevTools Protocol client, just enough to drive the real app.

  Deliberately dependency-free. Node 22+ ships a global `WebSocket`, which
  retires the single worst trap of this project's previous (uncommitted, since
  lost) harness: it lived in a scratchpad outside the repo, so `require('ws')`
  did not resolve and every copy had to hardcode an absolute path into
  node_modules. There is nothing to resolve now.

  Scope is deliberately small — connect, send a command, await its reply. No
  event subscription, no domain wrappers, no reconnection. Everything this
  harness needs to know it reads with Runtime.evaluate, and everything it
  changes it changes the same way.
*/

/** How long a single CDP command may take before we stop waiting for it. */
const COMMAND_TIMEOUT_MS = 15_000;

/*
  How we recognise the app's own page.

  Matching on the URL was the obvious approach and it is wrong: `tauri dev`
  serves the frontend from a dev server (`http://127.0.0.1:1430/`) while a
  bundled build loads `http://tauri.localhost/index.html`, and MilkDrop runs in
  its own CSP-isolated iframe that can surface as a separate target. Any URL
  pattern that covers all of those is either too loose to be safe or has to be
  revisited every time the shell changes.

  So identify the page by asking it. `canRender` is a top-level `let` in
  renderer.js — the very binding the harness exists to read — so a target that
  answers to it is by definition the one worth measuring.
*/
const PAGE_SIGNATURE = 'typeof canRender === "function" && typeof drawCostMs === "number"';

/**
 * Wait for the app's page to exist, then return a session attached to it.
 *
 * WebView2 opens the port before the page is navigated and briefly reports an
 * empty list or `about:blank`. Attaching to that yields a session that works
 * and evaluates against the wrong document — which surfaces as "every probe
 * returns undefined" rather than as an error, so it is worth being strict here
 * rather than debugging it later.
 *
 * @param {number} port DevTools remote-debugging port.
 * @param {number} timeoutMs How long to keep trying before giving up.
 * @returns {Promise<{session: CdpSession, url: string}>}
 */
export async function attachToApp(port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = 'nothing at all';
  while (Date.now() < deadline) {
    let targets = [];
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      targets = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 250));
      continue; // Port not up yet. Expected for the first seconds of a cold launch.
    }

    const candidates = targets.filter(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url && t.url !== 'about:blank'
    );
    for (const target of candidates) {
      let session;
      try {
        session = await CdpSession.connect(target.webSocketDebuggerUrl);
        if (await session.evaluate(`return ${PAGE_SIGNATURE};`)) return { session, url: target.url };
        session.close();
      } catch {
        session?.close(); // Target vanished mid-handshake, or is still loading.
      }
    }
    lastSeen = targets.length ? targets.map((t) => `${t.type}:${t.url}`).join(', ') : 'an empty target list';
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `no page answering to renderer.js's globals on port ${port} within ${timeoutMs}ms — last saw ${lastSeen}.\n` +
      'If the port never opened at all, the build is missing --remote-debugging-port: wry always calls\n' +
      'set_additional_browser_arguments, which overrides WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, so the\n' +
      'flag has to come from the Tauri config. See README.md in this directory.'
  );
}

/** A connected CDP session against one page. */
export class CdpSession {
  #ws;
  #nextId = 1;
  #pending = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onMessage(ev));
    ws.addEventListener('close', () => {
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(new Error('CDP socket closed while a command was in flight — the app most likely exited'));
      }
      this.#pending.clear();
    });
  }

  /**
   * Open a session against a page target.
   *
   * @param {string} wsUrl `webSocketDebuggerUrl` from the target list.
   * @returns {Promise<CdpSession>}
   */
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => resolve(new CdpSession(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot open CDP socket ${wsUrl}`)), { once: true });
    });
  }

  #onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return; // Not ours to interpret; events we don't subscribe to are ignored.
    }
    const entry = this.#pending.get(msg.id);
    if (!entry) return; // A protocol event rather than a command reply.
    clearTimeout(entry.timer);
    this.#pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(`${msg.error.message} (CDP ${entry.method})`));
    else entry.resolve(msg.result);
  }

  /**
   * Send one CDP command and await its reply.
   *
   * @param {string} method e.g. `Runtime.evaluate`.
   * @param {object} [params]
   * @returns {Promise<object>} The command's `result`.
   */
  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} did not reply within ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate an expression in the page and return its value.
   *
   * `awaitPromise` defaults to **false**, and callers should think hard before
   * turning it on. The recorded trap from this project's earlier harness: a
   * call that resolves only after a file is read, decoded and started playing
   * leaves the harness sitting silent with no way to distinguish loading from
   * hung. Fire it and poll for the effect instead.
   *
   * Note that `renderer.js` is a classic script (index.html), so its top-level
   * `let` bindings — drawCostMs, frameIntervalMs, perfCost, cues — are global
   * lexical bindings and are both readable and assignable from here. That is
   * why this harness needs no instrumentation hooks in production code.
   *
   * @param {string} expression
   * @param {{awaitPromise?: boolean}} [opts]
   * @returns {Promise<any>} The value, deserialized.
   */
  async evaluate(expression, opts = {}) {
    const result = await this.send('Runtime.evaluate', {
      // Wrapped so callers can write statements, not just expressions.
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: Boolean(opts.awaitPromise),
    });
    if (result.exceptionDetails) {
      const ex = result.exceptionDetails;
      throw new Error(`page threw: ${ex.exception?.description || ex.text}`);
    }
    return result.result?.value;
  }

  /** Close the socket. Safe to call twice. */
  close() {
    try {
      this.#ws.close();
    } catch {
      // Already closed.
    }
  }
}
