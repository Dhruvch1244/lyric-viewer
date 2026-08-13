# Lyric Overlay — website & browser demo

Static site + in-browser demo, served from GitHub Pages at
`lyricoverlay.dhruvchoudhary.com`.

```
web/
├── index.html      Landing page
├── privacy.html    Privacy policy (the URL given to the Microsoft Store)
├── demo.html       Browser demo UI
├── demo.js         Demo logic (Butterchurn + LRCLIB + .lrc sync)
├── CNAME           Custom domain for GitHub Pages
├── assets/         Favicon, logo, Butterchurn bundles
└── worker/         Optional Cloudflare Worker lyrics proxy
```

## Preview locally

The demo needs `http://` (not `file://`) for the AudioContext and fetch to work:

```bash
npx serve web
# or:  python -m http.server -d web 8080
```

Then open <http://localhost:3000/demo.html>.

## Deploy (GitHub Pages + Cloudflare)

1. Push `web/` to `main`. The `pages` Action (`.github/workflows/pages.yml`)
   publishes it.
2. **GitHub → Settings → Pages → Source: GitHub Actions.**
3. **Cloudflare → dhruvchoudhary.com → DNS:** add `CNAME`
   `lyricoverlay → dhruvch1244.github.io`, **proxy DNS-only (grey cloud)** so
   GitHub can issue the TLS certificate.
4. **GitHub → Settings → Pages → Custom domain:** confirm
   `lyricoverlay.dhruvchoudhary.com`, then enable **Enforce HTTPS**.

## Optional: the lyrics proxy

LRCLIB allows browser CORS, so the demo works without a proxy. Deploy the
Worker only for a stable same-origin endpoint or to add CORS-blocked providers:

```bash
cd web/worker
npx wrangler deploy
```

Then set `LYRICS_BASE` in `web/demo.js` to the Worker's URL.

## To do when the Store listing is live

- Replace the placeholder `#` on the "Get it on Microsoft Store" button in
  `index.html` (search `data-store`) with the real product URL.
