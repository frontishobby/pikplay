// Local stand-in for the Supabase Edge Function: the same relay code on
// 127.0.0.1, started together with `vite dev`.
//
// With PIKPAK_PAT set it enforces the token exactly like the deployed function;
// without it any token is relayed, which is acceptable only because it listens
// on localhost.
import http from 'node:http'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { createRelay } from '../supabase/functions/pikplay/handler.ts'

async function toRequest(req) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  let body
  if (req.method === 'POST') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    body = Buffer.concat(chunks)
  }
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body })
}

export function startProxy(port = 8787) {
  const relay = createRelay({ token: process.env.PIKPAK_PAT ?? null })
  const server = http.createServer(async (req, res) => {
    try {
      const response = await relay(await toRequest(req))
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) Readable.fromWeb(response.body).pipe(res)
      else res.end()
    } catch (err) {
      console.error('[relay] failed:', err instanceof Error ? err.message : err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  // A second dev server on the same machine can reuse the relay that is already up.
  server.on('error', (err) => console.warn(`[relay] not started: ${err.message}`))
  server.listen(port, '127.0.0.1', () => console.log(`[relay] http://127.0.0.1:${port}`))
  return server
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startProxy(Number(process.env.PORT) || 8787)
}
