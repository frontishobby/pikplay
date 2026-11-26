// Unofficial PikPak drive client for the browser, authenticated with a
// Personal Access Token (Account & Security → Connected Apps).

const PROXY_BASE: string = import.meta.env.VITE_CORS_PROXY ?? 'http://127.0.0.1:8787/'
const PROXY_AUTH: string | undefined = import.meta.env.VITE_CORS_PROXY_AUTH

const DRIVE_API = 'https://api-drive.mypikpak.com'
const CLIENT_ID = 'YUMx5nI8ZU8Ap8pm'

const STORAGE_KEY = 'pikplay.session'

/** Rewrites a URL so the request goes through the CORS relay. */
export function proxied(url: string): string {
  return PROXY_BASE + url
}

/** Headers the relay needs on top of the request's own; `origin` is what upstream should see. */
export function proxyHeaders(origin?: string): Record<string, string> {
  const headers: Record<string, string> = {}
  if (PROXY_AUTH) headers['x-proxy-auth'] = PROXY_AUTH
  if (origin) headers['x-proxy-header-origin'] = origin
  return headers
}

interface Session {
  deviceId: string
  token: string
}

export interface MediaVariant {
  media_id: string
  media_name: string
  /** True for the uploaded file itself; false for PikPak's transcodes. */
  is_origin?: boolean
  is_default?: boolean
  is_visible?: boolean
  video?: {
    width: number
    height: number
    duration: number
    bit_rate?: number
    video_codec?: string
    /** Container as ffprobe names it, e.g. "mpegts" or "mov,mp4,m4a,3gp,3g2,mj2". */
    video_type?: string
  }
  link?: { url: string; expire?: string }
}

export interface DriveFile {
  id: string
  kind: 'drive#folder' | 'drive#file'
  name: string
  size: string
  parent_id?: string
  mime_type?: string
  created_time?: string
  modified_time: string
  /** Extra per-type metadata; videos may carry `duration` in seconds. */
  params?: { duration?: string }
  thumbnail_link?: string
  icon_link?: string
  web_content_link?: string
  medias?: MediaVariant[]
}

export class PikPakError extends Error {
  code: number

  constructor(message: string, code: number) {
    super(message)
    this.name = 'PikPakError'
    this.code = code
  }
}

function randomDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function loadSession(): Session {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Session>
    return { deviceId: saved.deviceId || randomDeviceId(), token: saved.token ?? '' }
  } catch {
    // Unreadable storage just means starting logged out.
    return { deviceId: randomDeviceId(), token: '' }
  }
}

export class PikPak {
  private session: Session = loadSession()

  get loggedIn(): boolean {
    return this.session.token !== ''
  }

  private save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.session))
  }

  /** Stores the token only once a real API call has accepted it. */
  async login(token: string): Promise<void> {
    const previous = this.session.token
    this.session.token = token
    try {
      await this.request('GET', '/drive/v1/files', { parent_id: '', limit: '1' })
    } catch (err) {
      this.session.token = previous
      throw err
    }
    this.save()
  }

  logout(): void {
    this.session.token = ''
    this.save()
  }

  private async request<T>(method: string, path: string, query: Record<string, string> = {}): Promise<T> {
    const target = new URL(DRIVE_API + path)
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value)

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.session.token}`,
      'x-device-id': this.session.deviceId,
      'x-client-id': CLIENT_ID,
    }
    Object.assign(headers, proxyHeaders())

    const response = await fetch(proxied(target.href), { method, headers })
    const data = await response.json().catch(() => ({}))
    const code: number = data.error_code ?? 0
    if (response.ok && code === 0) return data as T
    throw new PikPakError(data.error_description || data.error || `HTTP ${response.status}`, code)
  }

  /** Lists every non-trashed entry in a folder; `''` is the drive root. */
  async list(parentId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = []
    let pageToken = ''
    do {
      const page = await this.request<{ files: DriveFile[]; next_page_token?: string }>('GET', '/drive/v1/files', {
        parent_id: parentId,
        thumbnail_size: 'SIZE_LARGE',
        with_audit: 'true',
        limit: '100',
        filters: '{"phase":{"eq":"PHASE_TYPE_COMPLETE"},"trashed":{"eq":false}}',
        page_token: pageToken,
      })
      files.push(...(page.files ?? []))
      pageToken = page.next_page_token ?? ''
    } while (pageToken)
    return files
  }

  /** Fetches one file with fresh, short-lived download and streaming links. */
  async detail(fileId: string): Promise<DriveFile> {
    return this.request<DriveFile>('GET', `/drive/v1/files/${fileId}`, {
      _magic: '2021',
      usage: 'CACHE',
      thumbnail_size: 'SIZE_LARGE',
    })
  }
}
