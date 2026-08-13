/*
  Cloudflare Worker: CORS-friendly lyrics proxy for the Lyric Overlay browser
  demo. LRCLIB already allows cross-origin requests, so the demo talks to it
  directly by default; deploy this only if you want a stable same-origin
  endpoint or plan to add providers that block CORS.

  Deploy:  cd web/worker && npx wrangler deploy
  Then set LYRICS_BASE in web/demo.js to this Worker's URL.
*/

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
};

const UA = 'LyricOverlayDemo/1.0 (+https://lyricoverlay.dhruvchoudhary.com)';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405);
    }

    const url = new URL(request.url);

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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
