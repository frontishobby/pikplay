# pikplay

Prototype: browse and play PikPak files from a static page (Svelte 5 + TypeScript),
authenticated with a PikPak Personal Access Token (Account & Security → Connected
Apps → Personal Access Tokens; the default Read files permission is enough).

PikPak's API only answers CORS preflights for its own origin, so every API call is
relayed through a CORS proxy. Video bytes are not relayed — the short-lived CDN
link goes straight into `<video>`.

## Run

```bash
npm install
npm run dev
```

`npm run dev` also starts the local relay (`proxy/server.mjs`) on
`http://127.0.0.1:8787`. It only forwards to `*.mypikpak.com` / `*.mypikpak.net`.

## Switching to cors--proxy

The local relay follows the same contract (path-form target, `x-proxy-header-*`
overrides), so only the environment changes:

```bash
# .env.local
VITE_CORS_PROXY=https://cors--proxy.duckdns.org/
VITE_CORS_PROXY_AUTH=<sha-256 hash of the proxy password>
```

## Layout

- `src/lib/pikpak.ts` — API client (token check, list, links)
- `src/lib/library.ts` — folder cache, sorting, playable-file detection
- `src/lib/store.svelte.ts` — preferences, watch history, folder names (localStorage)
- `src/lib/router.svelte.ts` — hash routes (`#/f/<folder>`, `#/w/<folder>/<file>`)
- `src/lib/Login.svelte`, `Library.svelte`, `Player.svelte` — screens
- `proxy/server.mjs` — local CORS relay
