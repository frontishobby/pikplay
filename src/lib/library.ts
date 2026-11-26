import type { DriveFile, PikPak } from './pikpak'

export type SortKey = 'name' | 'modified' | 'size'
export type SortDir = 'asc' | 'desc'

const PLAYABLE_EXT = /\.(mp4|mkv|webm|mov|avi|wmv|flv|m4v|ts|mpg|mpeg|3gp|rmvb|mp3|m4a|flac|ogg|wav)$/i
// Thumbnail links are signed and expire, so listings can't be kept for long.
const CACHE_TTL_MS = 5 * 60_000

export function isFolder(file: DriveFile): boolean {
  return file.kind === 'drive#folder'
}

export function isPlayable(file: DriveFile): boolean {
  if (isFolder(file)) return false
  return /^(video|audio)\//.test(file.mime_type ?? '') || PLAYABLE_EXT.test(file.name)
}

/** Length in seconds as reported by the listing, or 0 when PikPak doesn't say. */
export function durationOf(file: DriveFile): number {
  return Number(file.params?.duration) || file.medias?.find((media) => media.video?.duration)?.video?.duration || 0
}

export function sortFiles(files: DriveFile[], key: SortKey, dir: SortDir): DriveFile[] {
  const sign = dir === 'asc' ? 1 : -1
  const compare = (a: DriveFile, b: DriveFile): number => {
    if (key === 'size') return Number(a.size) - Number(b.size)
    if (key === 'modified') return a.modified_time.localeCompare(b.modified_time)
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  }
  return [...files].sort((a, b) => sign * compare(a, b) || a.name.localeCompare(b.name, undefined, { numeric: true }))
}

const cache = new Map<string, { at: number; files: Promise<DriveFile[]> }>()

/** Folder listing, shared between the library and the player's playlist. */
export function getFolder(client: PikPak, folderId: string, force = false): Promise<DriveFile[]> {
  const hit = cache.get(folderId)
  if (hit && !force && Date.now() - hit.at < CACHE_TTL_MS) return hit.files

  const files = client.list(folderId)
  cache.set(folderId, { at: Date.now(), files })
  files.catch(() => {
    if (cache.get(folderId)?.files === files) cache.delete(folderId)
  })
  return files
}

export function clearFolderCache(): void {
  cache.clear()
}
