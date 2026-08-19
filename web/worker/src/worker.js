/*
  Cloudflare Worker: CORS-friendly lyrics proxy for the Lyric Overlay browser
  demo, plus the desktop app's opt-in remote crash-report intake.

  LYRICS PROXY: LRCLIB already allows cross-origin requests, so the demo
  talks to it directly by default; deploy this only if you want a stable
  same-origin endpoint or plan to add providers that block CORS.

  CRASH REPORTS: the desktop app's local-only crash log (crashlog.rs) can
  optionally POST here too, but ONLY when the user has explicitly turned on
  "Send crash reports" in the 🔑 panel — off by default, an app-side decision,
  not something this Worker enforces. Reports are small (kind/message/
  appVersion/os, capped) and never include what track was playing or any
  lyric text. Written to KV so there's somewhere for them to land; nothing
  here re-sends them anywhere else automatically — check with GET
  /api/crash-reports (ADMIN_TOKEN-gated, see below) when you want to look.

  SITE PAGEVIEWS: web/index.html and web/demo.html can optionally beacon a
  page path here on load — no cookies, no IP storage, no third-party
  service, just a same-origin counter bump so there's SOME visibility into
  whether the marketing site converts to a download, instead of none. Off
  by default: the page-side constant that points at this Worker is empty
  until you deploy and fill it in (see web/index.html's own comment). Counts
  only — never referrer, user agent, or anything resembling a visitor ID.

  Deploy:  cd web/worker && npx wrangler deploy
  Then set LYRICS_BASE in web/demo.js to this Worker's URL.

  One-time setup for crash reports (optional — the lyrics proxy above works
  without this):
    npx wrangler kv namespace create CRASH_REPORTS
    # paste the returned id into wrangler.toml's [[kv_namespaces]] block
    npx wrangler secret put ADMIN_TOKEN
    # pick any long random string; this is what you'll pass as
    # ?token=<value> to GET /api/crash-reports (and /api/stats below) to
    # read them back

  One-time setup for pageviews (optional, same ADMIN_TOKEN as above):
    npx wrangler kv namespace create SITE_STATS
    # paste the returned id into wrangler.toml's [[kv_namespaces]] block
    # then point SITE_STATS_ENDPOINT (web/index.html, web/demo.html) at
    # this Worker's URL — https://<worker>.workers.dev or the routed domain
*/

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
};

const UA = 'LyricOverlayDemo/1.0 (+https://lyricoverlay.dhruvchoudhary.com)';

// A crash report is a debug string, not a document — this is generous
// (~4x a typical entry) while still rejecting anything trying to smuggle a
// large payload through an unauthenticated public endpoint.
const MAX_REPORT_BYTES = 8 * 1024;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/crash-report' && request.method === 'POST') {
      return handleCrashReport(request, env);
    }
    if (url.pathname === '/api/crash-reports' && request.method === 'GET') {
      return listCrashReports(url, env);
    }
    if (url.pathname === '/api/pageview' && request.method === 'POST') {
      return handlePageview(request, env);
    }
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      return getStats(url, env);
    }

    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405);
    }

    // Only proxy the LRCLIB read endpoints, nothing else.
    if (url.pathname === '/api/search' || url.pathname === '/api/get') {
      const target = `https://lrclib.net${url.pathname}${url.search}`;
      try {
        const upstream = await fetch(target, {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
        const body = await upstream.text();
        return new Response(body, {
          status: upstream.status,
          headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
        });
      } catch (err) {
        return json({ error: 'upstream fetch failed', detail: String(err) }, 502);
      }
    }

    return json({ error: 'not found' }, 404);
  },
};

/**
 * Accept one opt-in crash report and persist it to KV. Silently ignores
 * anything malformed or oversized rather than erroring loudly — the app
 * treats this as fire-and-forget and never surfaces a failure to the user,
 * so there's no one to show an error to anyway.
 */
async function handleCrashReport(request, env) {
  if (!env.CRASH_REPORTS) {
    // KV not provisioned on this deployment — see the setup note above.
    return json({ error: 'crash reporting not configured on this deployment' }, 503);
  }
  const raw = await request.text();
  if (!raw || raw.length > MAX_REPORT_BYTES) {
    return json({ status: 'ignored' }, 202);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ status: 'ignored' }, 202);
  }
  const kind = typeof data.kind === 'string' ? data.kind.slice(0, 40) : 'unknown';
  const message = typeof data.message === 'string' ? data.message.slice(0, 4000) : '';
  if (!message) return json({ status: 'ignored' }, 202);

  const entry = {
    kind,
    message,
    appVersion: typeof data.appVersion === 'string' ? data.appVersion.slice(0, 40) : '',
    os: typeof data.os === 'string' ? data.os.slice(0, 40) : '',
    receivedAt: new Date().toISOString(),
  };
  // Sortable-by-time key with a random suffix so two reports in the same
  // millisecond never collide.
  const key = `${entry.receivedAt}-${crypto.randomUUID().slice(0, 8)}`;
  // KV has no real query API, so a 90-day TTL is the retention policy —
  // reports are a debugging aid, not something to keep indefinitely.
  await env.CRASH_REPORTS.put(key, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 90 });

  return json({ status: 'ok' });
}

/** Admin-only listing, gated on a bearer-ish query token rather than a full
 * auth system — this is a maintainer reading their own debug log, not a
 * multi-user product surface. */
async function listCrashReports(url, env) {
  if (!env.CRASH_REPORTS || !env.ADMIN_TOKEN) {
    return json({ error: 'crash reporting not configured on this deployment' }, 503);
  }
  if (url.searchParams.get('token') !== env.ADMIN_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);
  const list = await env.CRASH_REPORTS.list({ limit });
  const entries = await Promise.all(list.keys.map((k) => env.CRASH_REPORTS.get(k.name)));
  return json({
    reports: entries.filter(Boolean).map((e) => JSON.parse(e)),
    cursor: list.cursor || null,
  });
}

/**
 * Bump a same-origin pageview counter. Fire-and-forget from the page's own
 * perspective (sendBeacon/fetch with no awaited response), so this fails
 * open exactly like crash reporting: no KV configured, no error surfaced,
 * the page behaves identically either way.
 *
 * Counts only — no per-visitor identity, no IP, no cookie. KV's get-then-put
 * isn't atomic, so two requests landing in the same instant can race and
 * undercount by one; acceptable for a low-traffic marketing site where the
 * shape of the trend matters far more than the exact integer.
 */
async function handlePageview(request, env) {
  if (!env.SITE_STATS) {
    return json({ error: 'pageview tracking not configured on this deployment' }, 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ status: 'ignored' }, 202);
  }
  const path = (typeof body.path === 'string' ? body.path : '/').split(/[?#]/)[0].slice(0, 200) || '/';
  const day = new Date().toISOString().slice(0, 10);
  await Promise.all([bump(env.SITE_STATS, 'total'), bump(env.SITE_STATS, `day:${day}`), bump(env.SITE_STATS, `page:${path}`)]);
  return json({ status: 'ok' });
}

async function bump(kv, key) {
  const current = Number(await kv.get(key)) || 0;
  await kv.put(key, String(current + 1));
}

/** Admin-only readback of the pageview counters, same gating as crash reports. */
async function getStats(url, env) {
  if (!env.SITE_STATS || !env.ADMIN_TOKEN) {
    return json({ error: 'pageview tracking not configured on this deployment' }, 503);
  }
  if (url.searchParams.get('token') !== env.ADMIN_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  const total = Number(await env.SITE_STATS.get('total')) || 0;
  const days = await env.SITE_STATS.list({ prefix: 'day:', limit: 90 });
  const pages = await env.SITE_STATS.list({ prefix: 'page:', limit: 200 });
  const byDay = Object.fromEntries(
    await Promise.all(days.keys.map(async (k) => [k.name.slice(4), Number(await env.SITE_STATS.get(k.name)) || 0])),
  );
  const byPage = Object.fromEntries(
    await Promise.all(pages.keys.map(async (k) => [k.name.slice(5), Number(await env.SITE_STATS.get(k.name)) || 0])),
  );
  return json({ total, byDay, byPage });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
