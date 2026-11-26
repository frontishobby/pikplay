# pikplay

Browse and play the videos in a PikPak drive from a static page
(Svelte 5 + TypeScript). Live at https://pikplay.duckdns.org.

You sign in with two things:

- a **PikPak Personal Access Token** — Account & Security → Connected Apps →
  Personal Access Tokens. The default *Read files* permission is enough.
- the address of **your own relay** (below).

## Why a relay

PikPak's API answers CORS requests only from its own site, so a page on another
origin cannot call it directly. The relay is a small Supabase Edge Function that
forwards those calls. Only the API calls go through it (file lists, link lookups,
stream playlists); video data comes straight from PikPak's CDN.

It is not an open proxy:

- it serves a request only if the bearer token equals the one token stored in
  its `PIKPAK_PAT` secret, so the address alone is useless to anyone else
- it reaches only `api-drive.mypikpak.com` and `web-vod-xdrive.mypikpak.com`
- it logs nothing

## Deploy the relay

With the [Supabase CLI](https://supabase.com/docs/guides/cli) and a project:

```bash
supabase login
supabase secrets set PIKPAK_PAT=<your token> --project-ref <ref>
supabase functions deploy pikplay --project-ref <ref>
```

`supabase/config.toml` turns off Supabase's JWT check for this function: the
`Authorization` header carries the PikPak token, and the function checks it
itself. The relay address to enter at sign-in is then

```
https://<ref>.supabase.co/functions/v1/pikplay
```

When the token expires or is regenerated, set the secret again and sign in with
the new one.

## Develop

```bash
npm install
npm run dev
```

`npm run dev` also starts the same relay code on `http://127.0.0.1:8787`
(`proxy/server.mjs`), which the sign-in form pre-fills. Without `PIKPAK_PAT` in
the environment it relays any token; it only listens on localhost.

Pushing to `main` deploys to GitHub Pages.

## Layout

- `src/lib/pikpak.ts` — API client (token check, list, links)
- `src/lib/library.ts` — folder cache, sorting, playable-file detection
- `src/lib/store.svelte.ts` — preferences, watch history, folder names (localStorage)
- `src/lib/router.svelte.ts` — hash routes (`#/f/<folder>`, `#/w/<folder>/<file>`)
- `src/lib/Login.svelte`, `Library.svelte`, `Player.svelte` — screens
- `supabase/functions/pikplay/` — the relay (`handler.ts` is shared with local dev)
- `proxy/server.mjs` — runs the relay locally
