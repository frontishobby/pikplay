// Everything pikplay remembers in this browser besides the token.
import type { SortDir, SortKey } from './library'

const PREFS_KEY = 'pikplay.prefs'
const WATCH_KEY = 'pikplay.watch'
const FOLDERS_KEY = 'pikplay.folders'

const MAX_WATCH_ENTRIES = 300
const FINISHED_RATIO = 0.95

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: the app still works, it just forgets.
  }
}

export interface Prefs {
  volume: number
  muted: boolean
  rate: number
  loop: boolean
  autoplayNext: boolean
  /** Label of the source the user last picked by hand, e.g. "원본 파일". */
  quality: string
  view: 'grid' | 'list'
  sortKey: SortKey
  sortDir: SortDir
}

const DEFAULT_PREFS: Prefs = {
  volume: 1,
  muted: false,
  rate: 1,
  loop: false,
  autoplayNext: true,
  quality: '',
  view: 'grid',
  sortKey: 'name',
  sortDir: 'asc',
}

export const prefs = $state<Prefs>({ ...DEFAULT_PREFS, ...read<Partial<Prefs>>(PREFS_KEY, {}) })

export function savePrefs(): void {
  write(PREFS_KEY, $state.snapshot(prefs))
}

export interface WatchEntry {
  id: string
  name: string
  parentId: string
  position: number
  duration: number
  updatedAt: number
}

export const watch = $state({ entries: read<Record<string, WatchEntry>>(WATCH_KEY, {}) })

function persistWatch(): void {
  write(WATCH_KEY, $state.snapshot(watch.entries))
}

export function isFinished(entry: WatchEntry): boolean {
  return entry.duration > 0 && entry.position / entry.duration >= FINISHED_RATIO
}

export function watchedFraction(entry: WatchEntry | undefined): number {
  if (!entry || entry.duration <= 0) return 0
  return Math.min(1, entry.position / entry.duration)
}

export function recordProgress(entry: WatchEntry): void {
  watch.entries[entry.id] = entry
  const ids = Object.keys(watch.entries)
  if (ids.length > MAX_WATCH_ENTRIES) {
    ids
      .sort((a, b) => watch.entries[a].updatedAt - watch.entries[b].updatedAt)
      .slice(0, ids.length - MAX_WATCH_ENTRIES)
      .forEach((id) => delete watch.entries[id])
  }
  persistWatch()
}

export function forgetProgress(id: string): void {
  delete watch.entries[id]
  persistWatch()
}

interface FolderInfo {
  name: string
  parentId: string
}

// Names of folders seen so far, so breadcrumbs for a deep link need no API calls.
const folders = read<Record<string, FolderInfo>>(FOLDERS_KEY, {})

export function knownFolder(id: string): FolderInfo | undefined {
  return folders[id]
}

export function rememberFolders(list: Array<FolderInfo & { id: string }>): void {
  if (list.length === 0) return
  for (const { id, name, parentId } of list) folders[id] = { name, parentId }
  write(FOLDERS_KEY, folders)
}

/** Wipes watch history and folder names; called on logout. */
export function clearHistory(): void {
  for (const id of Object.keys(watch.entries)) delete watch.entries[id]
  for (const id of Object.keys(folders)) delete folders[id]
  localStorage.removeItem(WATCH_KEY)
  localStorage.removeItem(FOLDERS_KEY)
}
