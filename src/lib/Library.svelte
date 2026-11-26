<script lang="ts" module>
  // Scroll offsets per folder, kept across the trip to the player and back.
  const scrollMemo = new Map<string, number>()
</script>

<script lang="ts">
  import { tick, untrack } from 'svelte'
  import ContinueRow from './ContinueRow.svelte'
  import Icon from './Icon.svelte'
  import VideoCard from './VideoCard.svelte'
  import { formatDate, formatSize, formatTime } from './format'
  import { durationOf, getFolder, isFolder, isPlayable, removeFromFolder, sortFiles } from './library'
  import type { DriveFile, PikPak } from './pikpak'
  import { folderHref, navigate, watchHref } from './router.svelte'
  import { forgetProgress, isFinished, knownFolder, prefs, rememberFolders, watch, watchedFraction } from './store.svelte'

  interface Crumb {
    id: string
    name: string
  }

  const ROOT: Crumb = { id: '', name: '내 드라이브' }
  const MAX_FOLDER_DEPTH = 30

  let { client, folderId, onLogout }: { client: PikPak; folderId: string; onLogout: () => void } = $props()

  let files = $state<DriveFile[]>([])
  let crumbs = $state<Crumb[]>([ROOT])
  let loading = $state(false)
  let error = $state('')
  let query = $state('')

  const needle = $derived(query.trim().toLowerCase())
  const matching = $derived(needle ? files.filter((file) => file.name.toLowerCase().includes(needle)) : files)
  const folders = $derived(sortFiles(matching.filter(isFolder), prefs.sortKey, prefs.sortDir))
  const videos = $derived(sortFiles(matching.filter(isPlayable), prefs.sortKey, prefs.sortDir))
  const hiddenCount = $derived(files.filter((file) => !isFolder(file) && !isPlayable(file)).length)

  async function load(id: string, force = false) {
    // Read before the list changes: replacing it moves the scroll position.
    const restoreTo = force ? window.scrollY : (scrollMemo.get(id) ?? 0)
    loading = true
    error = ''
    try {
      const result = await getFolder(client, id, force)
      // A slower response for a folder we already left must not overwrite the current one.
      if (id !== folderId) return
      files = result
      rememberFolders(result.filter(isFolder).map((file) => ({ id: file.id, name: file.name, parentId: id })))
      await tick()
      window.scrollTo(0, restoreTo)
    } catch (err) {
      if (id === folderId) error = err instanceof Error ? err.message : String(err)
    } finally {
      if (id === folderId) loading = false
    }
  }

  /** Walks up from the folder, asking the API only about folders not seen before. */
  async function resolveCrumbs(id: string) {
    const chain: Crumb[] = []
    let cursor = id
    for (let depth = 0; cursor && depth < MAX_FOLDER_DEPTH; depth++) {
      let info = knownFolder(cursor)
      if (!info) {
        try {
          const detail = await client.detail(cursor)
          info = { name: detail.name, parentId: detail.parent_id ?? '' }
          rememberFolders([{ id: cursor, ...info }])
        } catch {
          // Unknown ancestor: show the part of the path we do know.
          break
        }
      }
      chain.unshift({ id: cursor, name: info.name })
      cursor = info.parentId
    }
    if (id === folderId) crumbs = [ROOT, ...chain]
  }

  async function trash(file: DriveFile) {
    if (!confirm(`이 영상을 PikPak 휴지통으로 옮길까요?\n\n${file.name}`)) return
    try {
      await client.trash([file.id])
    } catch (err) {
      alert(`삭제하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    removeFromFolder(folderId, file.id)
    forgetProgress(file.id)
    files = files.filter((item) => item.id !== file.id)
  }

  function playRandom() {
    const pick = videos[Math.floor(Math.random() * videos.length)]
    if (pick) navigate(watchHref(folderId, pick.id))
  }

  function cardMeta(file: DriveFile): string {
    return [formatSize(file.size), formatDate(file.modified_time)].filter(Boolean).join(' · ')
  }

  function lengthOf(file: DriveFile): number {
    return durationOf(file) || watch.entries[file.id]?.duration || 0
  }

  $effect(() => {
    const id = folderId
    untrack(() => {
      query = ''
      files = []
      crumbs = id ? [ROOT, { id, name: knownFolder(id)?.name ?? '…' }] : [ROOT]
      load(id)
      resolveCrumbs(id)
    })
  })
</script>

<svelte:window onscroll={() => scrollMemo.set(folderId, window.scrollY)} />

<header>
  <nav aria-label="경로">
    {#each crumbs as crumb, index (crumb.id)}
      {#if index > 0}<span class="muted">/</span>{/if}
      {#if index === crumbs.length - 1}
        <span class="current">{crumb.name}</span>
      {:else}
        <a href={folderHref(crumb.id)}>{crumb.name}</a>
      {/if}
    {/each}
  </nav>

  <div class="tools">
    <input class="search" type="search" placeholder="이 폴더에서 검색" bind:value={query} />
    <select bind:value={prefs.sortKey} aria-label="정렬 기준">
      <option value="name">이름</option>
      <option value="modified">날짜</option>
      <option value="size">크기</option>
    </select>
    <button
      class="icon-btn"
      onclick={() => (prefs.sortDir = prefs.sortDir === 'asc' ? 'desc' : 'asc')}
      title={prefs.sortDir === 'asc' ? '오름차순' : '내림차순'}
      aria-label="정렬 방향"
    >
      <Icon name={prefs.sortDir === 'asc' ? 'sortAsc' : 'sortDesc'} />
    </button>
    <button
      class="icon-btn"
      onclick={() => (prefs.view = prefs.view === 'grid' ? 'list' : 'grid')}
      title={prefs.view === 'grid' ? '목록으로 보기' : '썸네일로 보기'}
      aria-label="보기 방식"
    >
      <Icon name={prefs.view === 'grid' ? 'list' : 'grid'} />
    </button>
    <button class="icon-btn" onclick={playRandom} disabled={videos.length === 0} title="랜덤 재생" aria-label="랜덤 재생">
      <Icon name="shuffle" />
    </button>
    <button class="icon-btn" onclick={() => load(folderId, true)} disabled={loading} title="새로고침" aria-label="새로고침">
      <Icon name="refresh" />
    </button>
    <button onclick={onLogout}>로그아웃</button>
  </div>
</header>

<main>
  {#if folderId === '' && !needle}
    <ContinueRow {client} />
  {/if}

  {#if error}
    <p class="error">{error} <button onclick={() => load(folderId, true)}>다시 시도</button></p>
  {:else if loading && files.length === 0}
    <p class="muted">불러오는 중…</p>
  {:else if folders.length === 0 && videos.length === 0}
    <p class="muted">{needle ? '검색 결과가 없습니다.' : '재생할 수 있는 항목이 없습니다.'}</p>
  {:else}
    {#if folders.length > 0}
      <ul class="folders">
        {#each folders as folder (folder.id)}
          <li>
            <a href={folderHref(folder.id)} title={folder.name}>
              <Icon name="folder" size={20} />
              <span>{folder.name}</span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}

    {#if prefs.view === 'grid'}
      <div class="grid">
        {#each videos as file (file.id)}
          {@const entry = watch.entries[file.id]}
          <VideoCard
            href={watchHref(folderId, file.id)}
            name={file.name}
            thumbnail={file.thumbnail_link}
            duration={lengthOf(file)}
            fraction={watchedFraction(entry)}
            finished={entry ? isFinished(entry) : false}
            meta={cardMeta(file)}
            onRemove={() => trash(file)}
            removeLabel="휴지통으로 이동"
            removeIcon="trash"
          />
        {/each}
      </div>
    {:else}
      <ul class="rows">
        {#each videos as file (file.id)}
          {@const entry = watch.entries[file.id]}
          <li>
            <a href={watchHref(folderId, file.id)} title={file.name}>
              <span class="row-icon" class:done={entry && isFinished(entry)}>
                <Icon name={entry && isFinished(entry) ? 'check' : 'play'} size={18} />
              </span>
              <span class="row-name">{file.name}</span>
              <span class="row-meta">{lengthOf(file) ? formatTime(lengthOf(file)) : ''}</span>
              <span class="row-meta wide">{formatSize(file.size)}</span>
              <span class="row-meta wide">{formatDate(file.modified_time)}</span>
              {#if watchedFraction(entry) > 0}
                <span class="row-bar" style:width="{watchedFraction(entry) * 100}%"></span>
              {/if}
            </a>
            <button class="icon-btn" onclick={() => trash(file)} aria-label="휴지통으로 이동" title="휴지통으로 이동">
              <Icon name="trash" size={18} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  {#if hiddenCount > 0 && !needle}
    <p class="muted note">영상·오디오가 아닌 파일 {hiddenCount}개는 숨겼습니다.</p>
  {/if}
</main>

<style>
  header {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px 16px;
    padding: 10px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }

  nav {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  nav a {
    color: var(--muted);
    text-decoration: none;
  }

  nav a:hover {
    color: var(--text);
  }

  .current {
    font-weight: 600;
  }

  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .search,
  select {
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    color: var(--text);
    font: inherit;
  }

  .search {
    width: min(220px, 50vw);
  }

  main {
    max-width: 1600px;
    margin: 0 auto;
    padding: 20px 20px 60px;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .folders {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
    margin-bottom: 24px;
  }

  .folders a {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel);
    color: inherit;
    text-decoration: none;
  }

  .folders a:hover {
    background: var(--panel-hover);
  }

  .folders span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 22px 16px;
  }

  .rows li {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--border);
  }

  .rows li:hover {
    background: var(--panel);
  }

  .rows a {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 8px;
    color: inherit;
    text-decoration: none;
  }

  .row-icon {
    color: var(--muted);
  }

  .row-icon.done {
    color: var(--accent);
  }

  .row-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-meta {
    flex-shrink: 0;
    width: 80px;
    color: var(--muted);
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .row-bar {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    background: var(--accent);
  }

  .note {
    margin-top: 28px;
    font-size: 0.85rem;
  }

  @media (max-width: 640px) {
    .row-meta.wide {
      display: none;
    }

    .grid {
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    }
  }
</style>
