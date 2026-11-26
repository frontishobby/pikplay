// Unofficial PikPak drive client for the browser, authenticated with a
// Personal Access Token (Account & Security → Connected Apps).
//
// PikPak answers CORS requests only from its own site, so every call goes through
// a relay the user runs (supabase/functions/pikplay): `<relay>?url=<target>`.

const DRIVE_API = 'https://api-drive.mypikpak.com'
const CLIENT_ID = 'YUMx5nI8ZU8Ap8pm'

const STORAGE_KEY = 'pikplay.session'

/** Pre-filled relay address: the dev server's local relay, or nothing in a deployed build. */
export const DEFAULT_RELAY: string =
  import.meta.env.VITE_RELAY_URL ?? (import.meta.env.DEV ? 'http://127.0.0.1:8787/' : '')

interface Session {
  deviceId: string
  token: string
  relay: string
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
    return {
      deviceId: saved.deviceId || randomDeviceId(),
      token: saved.token ?? '',
      relay: saved.relay || DEFAULT_RELAY,
    }
  } catch {
    // Unreadable storage just means starting logged out.
    return { deviceId: randomDeviceId(), token: '', relay: DEFAULT_RELAY }
  }
}

export class PikPak {
  private session: Session = loadSession()

  get loggedIn(): boolean {
    return this.session.token !== '' && this.session.relay !== ''
  }

  /** The relay address in use, for pre-filling the login form. */
  get relay(): string {
    return this.session.relay
  }

  private save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.session))
  }

  /** Stores the relay and token only once a real API call through them has succeeded. */
  async login(relay: string, token: string): Promise<void> {
    let parsed: URL
    try {
      parsed = new URL(relay)
    } catch {
      throw new PikPakError('릴레이 주소가 올바른 URL이 아닙니다.', 0)
    }
    const previous = { ...this.session }
    this.session.relay = parsed.href
    this.session.token = token
    try {
      await this.request('/drive/v1/files', { parent_id: '', limit: '1' })
    } catch (err) {
      this.session = previous
      throw err
    }
    this.save()
  }

  logout(): void {
    this.session.token = ''
    this.save()
  }

  /** Address that fetches `url` through the relay. */
  relayed(url: string): string {
    const address = new URL(this.session.relay)
    address.searchParams.set('url', url)
    return address.href
  }

  /** Whether `url` is a request to the relay, as opposed to one straight to a CDN. */
  isRelayed(url: string): boolean {
    return url.startsWith(this.session.relay.split('?')[0])
  }

  /** The relay accepts a request only when it carries the token it was set up with. */
  relayHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.session.token}` }
  }

  private async request<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const target = new URL(DRIVE_API + path)
    for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value)

    let response: Response
    try {
      response = await fetch(this.relayed(target.href), {
        headers: { ...this.relayHeaders(), 'x-device-id': this.session.deviceId, 'x-client-id': CLIENT_ID },
      })
    } catch {
      throw new PikPakError('릴레이에 연결하지 못했습니다. 주소를 확인하세요.', 0)
    }
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
      const page = await this.request<{ files: DriveFile[]; next_page_token?: string }>('/drive/v1/files', {
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
    return this.request<DriveFile>(`/drive/v1/files/${fileId}`, {
      _magic: '2021',
      usage: 'CACHE',
      thumbnail_size: 'SIZE_LARGE',
    })
  }
}
