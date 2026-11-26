// Relay between the pikplay page and PikPak, whose API only answers CORS
// requests from its own site. Runtime-agnostic (web-standard APIs only): Supabase
// runs it through index.ts, local development through proxy/server.mjs.
//
//   GET <relay>?url=<encoded https URL>   with   Authorization: Bearer <PAT>
//
// Reads only, plus the few POST endpoints listed per upstream below.
//
// It is not an open proxy: the bearer token must equal the one PikPak Personal
// Access Token it was configured with, and only the hosts below are reachable.
// Nothing about a request is logged.

interface Upstream {
  /** Whether the caller's bearer token is passed on. */
  forwardAuth: boolean
  /** Origin header to present, for services that only answer PikPak's own site. */
  origin?: string
  /** Paths that may be POSTed to; everything else is GET only. */
  postPaths?: string[]
}

const UPSTREAMS: Record<string, Upstream> = {
  // batchTrash moves files to PikPak's trash, where they can still be restored.
  'api-drive.mypikpak.com': { forwardAuth: true, postPaths: ['/drive/v1/files:batchTrash'] },
  // Turns a transcoded stream into an HLS playlist; takes no credentials.
  'web-vod-xdrive.mypikpak.com': { forwardAuth: false, origin: 'https://mypikpak.com' },
}

const FORWARDED_HEADERS = ['accept', 'accept-language', 'user-agent', 'x-device-id', 'x-client-id']

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-device-id, x-client-id',
  'access-control-max-age': '86400',
}

export interface RelayOptions {
  /**
   * The only token this relay serves. An empty string means it was deployed
   * without one and refuses everything; `null` skips the check and is meant
   * for a relay bound to localhost.
   */
  token: string | null
}

function fail(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status, headers: CORS_HEADERS })
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

/** Compares via fixed-length digests so timing reveals nothing about the token. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(a), digest(b)])
  let difference = 0
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i]
  return difference === 0
}

export function createRelay(options: RelayOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
    if (request.method !== 'GET' && request.method !== 'POST') {
      return fail(405, 'method_not_allowed', 'Only GET and a few POST calls are relayed.')
    }

    if (options.token === '') return fail(500, 'relay_misconfigured', 'PIKPAK_PAT is not set on the relay.')
    const authorization = request.headers.get('authorization') ?? ''
    const presented = authorization.replace(/^Bearer\s+/i, '')
    if (options.token !== null && !(await sameSecret(presented, options.token))) {
      return fail(401, 'unauthorized', '릴레이에 등록된 토큰과 일치하지 않습니다.')
    }

    let target: URL
    try {
      target = new URL(new URL(request.url).searchParams.get('url') ?? '')
    } catch {
      return fail(400, 'bad_target', 'Pass the upstream address as ?url=<encoded https URL>.')
    }
    const upstream = target.protocol === 'https:' ? UPSTREAMS[target.hostname] : undefined
    if (!upstream) return fail(403, 'host_not_allowed', `${target.hostname} is not relayed.`)
    const isPost = request.method === 'POST'
    if (isPost && !upstream.postPaths?.includes(target.pathname)) {
      return fail(405, 'method_not_allowed', 'This call is read-only through the relay.')
    }

    const headers = new Headers()
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (upstream.forwardAuth && authorization) headers.set('authorization', authorization)
    if (upstream.origin) headers.set('origin', upstream.origin)
    if (isPost) headers.set('content-type', 'application/json')

    let response: Response
    try {
      response = await fetch(target, { method: request.method, headers, body: isPost ? await request.text() : undefined })
    } catch {
      return fail(502, 'upstream_failed', 'PikPak did not answer.')
    }
    return new Response(response.body, {
      status: response.status,
      headers: {
        ...CORS_HEADERS,
        'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'no-store',
      },
    })
  }
}
