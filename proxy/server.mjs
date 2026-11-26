// Minimal local CORS relay. Mirrors the subset of cors--proxy's contract that
// pikplay uses, so switching later is only a base-URL (+ x-proxy-auth) change:
//   - path form:            /https://host/path?query
//   - x-proxy-header-<name> → sent upstream as <name>
//   - browser origin/referer are stripped
import http from 'node:http'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const ALLOWED_HOST = /(^|\.)mypikpak\.(com|net)$/
const DROP_REQUEST = new Set([
  'host', 'origin', 'referer', 'connection', 'content-length',
  'accept-encoding', 'x-proxy-auth', 'x-proxy-password',
])
const DROP_RESPONSE = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection',
])
const OVERRIDE_PREFIX = 'x-proxy-header-'

function corsHeaders(req) {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
    'access-control-expose-headers': '*',
    'access-control-max-age': '86400',
    vary: 'origin',
  }
}

function sendJson(res, status, cors, body) {
  res.writeHead(status, { ...cors, 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function handle(req, res) {
  const cors = corsHeaders(req)

  if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
    res.writeHead(204, cors)
    res.end()
    return
  }

  let target
  try {
    target = new URL(req.url.slice(1))
  } catch {
    return sendJson(res, 400, cors, { error: 'bad_target', detail: 'use /https://host/path' })
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOST.test(target.hostname)) {
    return sendJson(res, 403, cors, { error: 'host_not_allowed', host: target.hostname })
  }

  const headers = {}
  const overrides = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith(OVERRIDE_PREFIX)) overrides[name.slice(OVERRIDE_PREFIX.length)] = value
    else if (!DROP_REQUEST.has(name) && !name.startsWith('sec-fetch-')) headers[name] = value
  }
  Object.assign(headers, overrides)

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? await readBody(req) : undefined,
  })

  const out = {}
  for (const [name, value] of upstream.headers) {
    if (!DROP_RESPONSE.has(name) && !name.startsWith('access-control-')) out[name] = value
  }
  res.writeHead(upstream.status, { ...out, ...cors })
  if (DEBUG_LINKS && /^\/drive\/v1\/files\/[^/]+$/.test(target.pathname)) {
    const body = Buffer.from(await upstream.arrayBuffer())
    res.end(body)
    describeLinks(body, req.headers.origin).catch((err) => console.warn('[links] failed:', err.message))
  } else if (upstream.body) Readable.fromWeb(upstream.body).pipe(res)
  else res.end()

  // File ids stay out of the log.
  const path = target.pathname.replace(/(\/files\/)[^/]+/, '$1…')
  console.log(`[proxy] ${req.method} ${target.host}${path} → ${upstream.status}`)
}

// PIKPLAY_DEBUG_LINKS=1: for each file-detail response, print what kind of links
// PikPak handed out and how they answer a browser-like request. File names, ids
// and the signed URLs themselves are never printed.
const DEBUG_LINKS = process.env.PIKPLAY_DEBUG_LINKS === '1'

async function probe(url, origin) {
  const { host, pathname, searchParams } = new URL(url)
  const where = `${host} .${pathname.split('.').pop().slice(0, 6)} params=[${[...searchParams.keys()].join(',')}]`
  try {
    const res = await fetch(url, { headers: { range: 'bytes=0-1023', ...(origin ? { origin } : {}) } })
    const head = Buffer.from(await res.arrayBuffer()).subarray(0, 16)
    return `${where} → ${res.status} type=${res.headers.get('content-type')} acao=${res.headers.get('access-control-allow-origin')} magic=${JSON.stringify(head.toString('latin1'))}`
  } catch (err) {
    return `${where} → fetch failed: ${err.message}`
  }
}

/** Asks PikPak's playlist service about a transcode, the way the player does. */
async function probePlaylist(mediaUrl) {
  const url = 'https://web-vod-xdrive.mypikpak.com/ts_downloader?client_id=UElLUEFLX1dFQg&url=' + encodeURIComponent(mediaUrl)
  try {
    const res = await fetch(url, { headers: { origin: 'https://mypikpak.com' } })
    const lines = (await res.text()).split(/\r?\n/)
    const tags = lines.filter((line) => line.startsWith('#')).slice(0, 7).join(' | ')
    const uris = lines.filter((line) => line && !line.startsWith('#'))
    const sameFile = uris.every((uri) => uri === mediaUrl)
    return `${res.status} type=${res.headers.get('content-type')} acao=${res.headers.get('access-control-allow-origin')} segments=${uris.length} segmentsPointAtMediaLink=${sameFile} :: ${tags}`
  } catch (err) {
    return `fetch failed: ${err.message}`
  }
}

async function describeLinks(body, origin) {
  const file = JSON.parse(body.toString('utf8'))
  const ext = String(file.name ?? '').split('.').pop()
  console.log(`[links] file .${ext} mime=${file.mime_type} size=${file.size} phase=${file.phase} medias=${file.medias?.length ?? 0}`)
  if (file.web_content_link) console.log(`[links]   original: ${await probe(file.web_content_link, origin)}`)
  for (const media of file.medias ?? []) {
    const v = media.video ?? {}
    console.log(
      `[links]   media "${media.media_name}" origin=${media.is_origin} default=${media.is_default} visible=${media.is_visible} ` +
        `${v.width}x${v.height} vcodec=${v.video_codec} acodec=${v.audio_codec} type=${v.video_type} category=${media.category}`,
    )
    console.log(`[links]     ${media.link?.url ? await probe(media.link.url, origin) : 'no link'}`)
    if (media.link?.url && !media.is_origin) console.log(`[links]     playlist: ${await probePlaylist(media.link.url)}`)
  }
}

export function startProxy(port = 8787) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[proxy] upstream failed:', err)
      if (!res.headersSent) sendJson(res, 502, corsHeaders(req), { error: 'upstream_failed', detail: String(err) })
      else res.destroy()
    })
  })
  // A second dev server on the same machine can reuse the relay that is already up.
  server.on('error', (err) => console.warn(`[proxy] not started: ${err.message}`))
  server.listen(port, '127.0.0.1', () => console.log(`[proxy] http://127.0.0.1:${port}`))
  return server
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startProxy(Number(process.env.PORT) || 8787)
}
