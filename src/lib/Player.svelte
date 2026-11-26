<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import Icon from './Icon.svelte'
  import { formatDate, formatSize, formatTime } from './format'
  import { durationOf, getFolder, isPlayable, removeFromFolder, sortFiles } from './library'
  import type { DriveFile, PikPak } from './pikpak'
  import { folderHref, navigate, watchHref } from './router.svelte'
  import { forgetProgress, isFinished, prefs, recordProgress, watch, watchedFraction } from './store.svelte'

  interface Source {
    label: string
    url: string
    /** 'file' goes straight into <video>; 'hls' is a playlist that needs hls.js. */
    kind: 'file' | 'hls'
    /** Where playback should start when the user has no remembered choice. */
    preferred: boolean
  }

  // PikPak's transcodes are one big HEVC MPEG-TS file, which no browser plays directly.
  // This service (the one the official web player uses) returns an HLS playlist of
  // byte ranges into that file.
  const TS_PLAYLIST_URL = 'https://web-vod-xdrive.mypikpak.com/ts_downloader?client_id=UElLUEFLX1dFQg&url='
  /** Containers a <video> element can't open, as named in `video_type`. */
  const NOT_NATIVE = /mpegts|avi|flv|asf|rm|mpeg\b/

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
  const HIDE_CONTROLS_MS = 2500
  const SAVE_INTERVAL_MS = 5000
  const OSD_MS = 700
  const DOUBLE_TAP_MS = 300
  const NEXT_COUNTDOWN_S = 5
  /** Below this, "resume" would just replay the first seconds; start from 0 instead. */
  const RESUME_MIN_S = 5

  let { client, fileId, folderId }: { client: PikPak; fileId: string; folderId: string } = $props()

  let stageEl = $state<HTMLDivElement>()
  let videoEl = $state<HTMLVideoElement>()
  let seekEl = $state<HTMLDivElement>()

  let file = $state<DriveFile | null>(null)
  let sources = $state<Source[]>([])
  let sourceIndex = $state(0)
  let siblings = $state<DriveFile[]>([])
  let playlistFolderId = $state('')
  let loading = $state(true)
  let failure = $state('')

  let paused = $state(true)
  let time = $state(0)
  let duration = $state(0)
  let bufferedEnd = $state(0)
  let waiting = $state(false)
  let fullscreen = $state(false)

  let controlsVisible = $state(true)
  let menuOpen = $state(false)
  let scrubbing = $state(false)
  let hoverRatio = $state<number | null>(null)
  let osd = $state('')
  let countdown = $state(0)
  /** Bumped to rebuild the <video> element when the same URL must be loaded again. */
  let reloadNonce = $state(0)

  // Plain bookkeeping that the template never reads.
  let loadSeq = 0
  let pendingSeek = 0
  let lastGoodTime = 0
  let lastSavedAt = 0
  let linksRefreshed = false
  let failedSources = new Set<number>()
  let lastTapAt = 0
  let lastPointerType = 'mouse'
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let osdTimer: ReturnType<typeof setTimeout> | undefined
  let countdownTimer: ReturnType<typeof setInterval> | undefined

  const currentSource = $derived<Source | undefined>(sources[sourceIndex])
  const currentSrc = $derived(currentSource?.url ?? '')
  const playlist = $derived(sortFiles(siblings.filter(isPlayable), prefs.sortKey, prefs.sortDir))
  const position = $derived(playlist.findIndex((item) => item.id === fileId))
  const prevFile = $derived(position > 0 ? playlist[position - 1] : null)
  const nextFile = $derived(position >= 0 && position < playlist.length - 1 ? playlist[position + 1] : null)
  const showControls = $derived(controlsVisible || paused || menuOpen || scrubbing || countdown > 0)
  const shownTime = $derived(scrubbing && hoverRatio !== null ? hoverRatio * duration : time)
  const canPip = typeof document !== 'undefined' && document.pictureInPictureEnabled

  /**
   * PikPak hands out stream links as http://, which an https page may not load.
   * The same hosts answer https, and the playlist service echoes whichever it is given.
   */
  function secure(url: string): string {
    // Loopback is exempt: a local stand-in server has no certificate, and browsers allow it anyway.
    return url.replace(/^http:\/\/(?!127\.0\.0\.1|localhost)/, 'https://')
  }

  function collectSources(detail: DriveFile): Source[] {
    const medias = detail.medias ?? []
    const original = medias.find((media) => media.is_origin)
    const originalUrl = secure(detail.web_content_link || original?.link?.url || '')
    const originalPlays = !NOT_NATIVE.test(original?.video?.video_type ?? '')

    const found: Source[] = []
    if (originalUrl) found.push({ label: '원본', url: originalUrl, kind: 'file', preferred: originalPlays })
    for (const media of medias) {
      if (media.is_origin || media.is_visible === false || !media.link?.url) continue
      const label = media.media_name || `${media.video?.height ?? '?'}p`
      if (found.some((source) => source.label === label)) continue
      const isTs = media.video?.video_type === 'mpegts'
      const link = secure(media.link.url)
      found.push({
        label,
        url: isTs ? TS_PLAYLIST_URL + encodeURIComponent(link) : link,
        kind: isTs ? 'hls' : 'file',
        preferred: !originalPlays && media.is_default === true,
      })
    }
    return found
  }

  /** The source with this label, else the one PikPak or the container suggests, else the first. */
  function indexOfLabel(list: Source[], label: string): number {
    const byLabel = list.findIndex((source) => source.label === label)
    if (byLabel >= 0) return byLabel
    return Math.max(0, list.findIndex((source) => source.preferred))
  }

  async function load(id: string) {
    const seq = ++loadSeq
    saveProgress()
    cancelCountdown()
    loading = true
    failure = ''
    file = null
    sources = []
    time = 0
    duration = 0
    bufferedEnd = 0
    lastGoodTime = 0
    linksRefreshed = false
    failedSources = new Set()

    try {
      const detail = await client.detail(id)
      if (seq !== loadSeq) return
      const found = collectSources(detail)
      if (found.length === 0) throw new Error('재생 가능한 링크가 없습니다.')

      const entry = watch.entries[id]
      pendingSeek = entry && !isFinished(entry) && entry.position > RESUME_MIN_S ? entry.position : 0
      file = detail
      sourceIndex = indexOfLabel(found, prefs.quality)
      sources = found
      loadPlaylist(folderId || detail.parent_id || '')
    } catch (err) {
      if (seq === loadSeq) failure = err instanceof Error ? err.message : String(err)
    } finally {
      if (seq === loadSeq) loading = false
    }
  }

  async function loadPlaylist(id: string) {
    playlistFolderId = id
    try {
      const result = await getFolder(client, id)
      if (id === playlistFolderId) siblings = result
    } catch {
      // The video itself still plays without a playlist.
    }
  }

  function saveProgress() {
    if (!file || lastGoodTime <= 0 || !Number.isFinite(duration) || duration <= 0) return
    lastSavedAt = Date.now()
    recordProgress({
      id: file.id,
      name: file.name,
      parentId: playlistFolderId,
      position: lastGoodTime,
      duration,
      updatedAt: lastSavedAt,
    })
  }

  // --- Media element events -------------------------------------------------

  // These read the element from the event: while sources are being swapped, `videoEl`
  // can briefly point at the element that is on its way out.
  function onLoadedMetadata(event: Event) {
    const video = event.currentTarget as HTMLVideoElement
    // A new source resets the rate, and the resume point has to wait for metadata.
    video.playbackRate = prefs.rate
    if (pendingSeek > 0 && pendingSeek < video.duration - 1) video.currentTime = pendingSeek
    pendingSeek = 0
  }

  function onTimeUpdate(event: Event) {
    const video = event.currentTarget as HTMLVideoElement
    if (video.currentTime > 0) lastGoodTime = video.currentTime
    if (Date.now() - lastSavedAt > SAVE_INTERVAL_MS) saveProgress()
  }

  function onProgress(event: Event) {
    const video = event.currentTarget as HTMLVideoElement
    const ranges = video.buffered
    let end = 0
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= video.currentTime + 1) end = Math.max(end, ranges.end(i))
    }
    bufferedEnd = end
  }

  function onEnded() {
    lastGoodTime = duration
    saveProgress()
    if (prefs.autoplayNext && nextFile) startCountdown()
  }

  /** First failure: links may have expired, so fetch fresh ones. After that, fall back to another source. */
  async function onError() {
    if (!file || !currentSrc) return
    const seq = loadSeq
    const resumeAt = lastGoodTime || pendingSeek
    const label = sources[sourceIndex]?.label ?? ''
    waiting = false

    if (!linksRefreshed) {
      linksRefreshed = true
      try {
        const fresh = collectSources(await client.detail(file.id))
        if (seq !== loadSeq) return
        if (fresh.length > 0) {
          pendingSeek = resumeAt
          sourceIndex = indexOfLabel(fresh, label)
          sources = fresh
          // The fresh link may be identical; the nonce makes sure it is loaded again.
          reloadNonce += 1
          return
        }
      } catch {
        if (seq !== loadSeq) return
      }
    }

    failedSources.add(sourceIndex)
    const fallback = sources.findIndex((_, index) => !failedSources.has(index))
    if (fallback < 0) {
      failure =
        '브라우저가 이 영상을 재생하지 못합니다. 원본은 형식이 맞지 않고, 변환 스트림(HEVC)도 이 브라우저에서 열리지 않았습니다.'
      return
    }
    pendingSeek = resumeAt
    sourceIndex = fallback
    flash(sources[fallback].label)
  }

  // --- Commands -------------------------------------------------------------

  function togglePlay() {
    if (!videoEl) return
    if (videoEl.paused) videoEl.play().catch(() => {})
    else videoEl.pause()
  }

  function seekTo(seconds: number) {
    if (!videoEl || !Number.isFinite(duration) || duration <= 0) return
    const target = Math.min(Math.max(seconds, 0), duration)
    videoEl.currentTime = target
    time = target
  }

  function seekBy(delta: number) {
    seekTo(time + delta)
    flash(`${delta > 0 ? '+' : '−'}${Math.abs(delta)}초`)
  }

  function setVolume(value: number) {
    prefs.volume = Math.min(Math.max(value, 0), 1)
    prefs.muted = prefs.volume === 0
    flash(`볼륨 ${Math.round(prefs.volume * 100)}%`)
  }

  function toggleMute() {
    prefs.muted = !prefs.muted
    if (!prefs.muted && prefs.volume === 0) prefs.volume = 0.5
    flash(prefs.muted ? '음소거' : `볼륨 ${Math.round(prefs.volume * 100)}%`)
  }

  function setRate(rate: number) {
    prefs.rate = rate
    if (videoEl) videoEl.playbackRate = rate
    flash(`${rate}x`)
  }

  function stepRate(direction: 1 | -1) {
    const nearest = SPEEDS.reduce((best, speed) => (Math.abs(speed - prefs.rate) < Math.abs(best - prefs.rate) ? speed : best))
    const index = SPEEDS.indexOf(nearest) + direction
    if (index >= 0 && index < SPEEDS.length) setRate(SPEEDS[index])
  }

  function selectSource(index: number) {
    if (index === sourceIndex) return
    pendingSeek = lastGoodTime
    prefs.quality = sources[index].label
    failedSources = new Set()
    failure = ''
    sourceIndex = index
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else if (stageEl?.requestFullscreen) {
      stageEl.requestFullscreen().catch(() => {})
    } else {
      // iPhone Safari only lets the <video> itself go fullscreen.
      ;(videoEl as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | undefined)?.webkitEnterFullscreen?.()
    }
  }

  function togglePip() {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})
    else videoEl?.requestPictureInPicture().catch(() => {})
  }

  function open(target: DriveFile | null) {
    if (target) navigate(watchHref(playlistFolderId, target.id), true)
  }

  /** Trashes the current video, then moves on to the next one or back to the folder. */
  async function trashCurrent() {
    const target = file
    if (!target || !confirm(`이 영상을 PikPak 휴지통으로 옮길까요?\n\n${target.name}`)) return
    const after = nextFile ?? prevFile
    try {
      await client.trash([target.id])
    } catch (err) {
      alert(`삭제하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // Nothing of it may be written back: with no current file, progress saving is a no-op.
    file = null
    forgetProgress(target.id)
    removeFromFolder(playlistFolderId, target.id)
    siblings = siblings.filter((item) => item.id !== target.id)
    if (after) open(after)
    else navigate(folderHref(playlistFolderId), true)
  }

  function startCountdown() {
    countdown = NEXT_COUNTDOWN_S
    countdownTimer = setInterval(() => {
      countdown -= 1
      if (countdown <= 0) {
        cancelCountdown()
        open(nextFile)
      }
    }, 1000)
  }

  function cancelCountdown() {
    clearInterval(countdownTimer)
    countdown = 0
  }

  // --- Controls visibility and feedback -------------------------------------

  function poke() {
    controlsVisible = true
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => (controlsVisible = false), HIDE_CONTROLS_MS)
  }

  function flash(text: string) {
    osd = text
    clearTimeout(osdTimer)
    osdTimer = setTimeout(() => (osd = ''), OSD_MS)
  }

  // --- Pointer input --------------------------------------------------------

  function onSurfacePointerUp(event: PointerEvent) {
    lastPointerType = event.pointerType
    if (menuOpen) {
      menuOpen = false
      return
    }
    if (event.pointerType === 'mouse') {
      if (event.button === 0) togglePlay()
      return
    }

    // Touch: one tap shows or hides the controls, a double tap seeks or goes fullscreen.
    const now = performance.now()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const side = (event.clientX - rect.left) / rect.width
    if (now - lastTapAt < DOUBLE_TAP_MS) {
      lastTapAt = 0
      if (side < 0.4) seekBy(-10)
      else if (side > 0.6) seekBy(10)
      else toggleFullscreen()
      return
    }
    lastTapAt = now
    if (controlsVisible && !paused) {
      clearTimeout(hideTimer)
      controlsVisible = false
    } else {
      poke()
    }
  }

  function onSurfaceDoubleClick() {
    if (lastPointerType === 'mouse') toggleFullscreen()
  }

  function ratioAt(event: PointerEvent): number {
    if (!seekEl) return 0
    const rect = seekEl.getBoundingClientRect()
    return Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
  }

  function onSeekPointerDown(event: PointerEvent) {
    seekEl?.setPointerCapture(event.pointerId)
    scrubbing = true
    hoverRatio = ratioAt(event)
    seekTo(hoverRatio * duration)
  }

  function onSeekPointerMove(event: PointerEvent) {
    hoverRatio = ratioAt(event)
    if (scrubbing) seekTo(hoverRatio * duration)
  }

  function onSeekPointerEnd() {
    scrubbing = false
    hoverRatio = null
    poke()
  }

  // --- Keyboard -------------------------------------------------------------

  function onKeydown(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select')) return
    // Let a focused button handle its own Space/Enter instead of also toggling playback.
    if ((event.key === ' ' || event.key === 'Enter') && target.closest('button, a')) return

    switch (event.key) {
      case ' ':
      case 'k':
        togglePlay()
        break
      case 'ArrowLeft':
        seekBy(event.shiftKey ? -30 : -5)
        break
      case 'ArrowRight':
        seekBy(event.shiftKey ? 30 : 5)
        break
      case 'j':
        seekBy(-10)
        break
      case 'l':
        seekBy(10)
        break
      case 'ArrowUp':
        setVolume((prefs.muted ? 0 : prefs.volume) + 0.05)
        break
      case 'ArrowDown':
        setVolume((prefs.muted ? 0 : prefs.volume) - 0.05)
        break
      case 'm':
        toggleMute()
        break
      case 'f':
        toggleFullscreen()
        break
      case 'i':
        if (canPip) togglePip()
        break
      case '<':
      case '[':
        stepRate(-1)
        break
      case '>':
      case ']':
        stepRate(1)
        break
      case 'N':
        open(nextFile)
        break
      case 'P':
        open(prevFile)
        break
      case 'Home':
        seekTo(0)
        break
      case 'End':
        seekTo(duration)
        break
      case 'Escape':
        if (menuOpen) menuOpen = false
        else if (countdown > 0) cancelCountdown()
        else if (!document.fullscreenElement) navigate(folderHref(playlistFolderId))
        else return
        break
      default:
        if (/^[0-9]$/.test(event.key)) seekTo((Number(event.key) / 10) * duration)
        else return
    }
    event.preventDefault()
    poke()
  }

  // --- Lifecycle ------------------------------------------------------------

  $effect(() => {
    const id = fileId
    untrack(() => load(id))
  })

  // Attaches hls.js to whichever <video> element is showing an HLS source.
  $effect(() => {
    const source = currentSource
    const element = videoEl
    if (!element || source?.kind !== 'hls') return

    let cancelled = false
    let detach = () => {}
    import('hls.js').then(({ default: Hls }) => {
      if (cancelled) return
      if (!Hls.isSupported()) {
        // iPhone Safari has no MediaSource but plays HLS itself.
        if (element.canPlayType('application/vnd.apple.mpegurl')) element.src = source.url
        else onError()
        return
      }
      const hls = new Hls({
        backBufferLength: 30,
        // Only the playlist goes through the relay; segments come straight from the CDN.
        xhrSetup(xhr, url) {
          if (!client.isRelayed(url)) return
          xhr.open('GET', url, true)
          for (const [name, value] of Object.entries(client.relayHeaders())) xhr.setRequestHeader(name, value)
        },
      })
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        console.warn('[pikplay] hls error:', data.type, data.details)
        hls.destroy()
        onError()
      })
      hls.loadSource(client.relayed(source.url))
      hls.attachMedia(element)
      detach = () => hls.destroy()
    })
    return () => {
      cancelled = true
      detach()
    }
  })

  $effect(() => {
    if (!('mediaSession' in navigator) || !file) return
    // Deliberately generic: the OS media widget and lock screen never show file names.
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'pikplay' })
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => void videoEl?.play()],
      ['pause', () => videoEl?.pause()],
      ['seekbackward', () => seekBy(-10)],
      ['seekforward', () => seekBy(10)],
      ['previoustrack', () => open(prevFile)],
      ['nexttrack', () => open(nextFile)],
    ]
    for (const [action, handler] of handlers) navigator.mediaSession.setActionHandler(action, handler)
    return () => {
      for (const [action] of handlers) navigator.mediaSession.setActionHandler(action, null)
    }
  })

  onDestroy(() => {
    saveProgress()
    clearTimeout(hideTimer)
    clearTimeout(osdTimer)
    clearInterval(countdownTimer)
  })
</script>

<svelte:window onkeydown={onKeydown} onpagehide={saveProgress} />
<svelte:document onfullscreenchange={() => (fullscreen = document.fullscreenElement !== null)} />

<div class="page">
  <div class="primary">
    <div
      class="stage"
      class:idle={!showControls}
      bind:this={stageEl}
      onpointermove={poke}
      role="region"
      aria-label="동영상 플레이어"
    >
      {#if currentSource}
        {#key `${currentSource.url}#${reloadNonce}`}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={videoEl}
          src={currentSource.kind === 'file' ? currentSource.url : undefined}
          autoplay
          playsinline
          loop={prefs.loop}
          bind:paused
          bind:currentTime={time}
          bind:duration
          bind:volume={prefs.volume}
          bind:muted={prefs.muted}
          onloadedmetadata={onLoadedMetadata}
          ontimeupdate={onTimeUpdate}
          onprogress={onProgress}
          onwaiting={() => (waiting = true)}
          onplaying={() => (waiting = false)}
          oncanplay={() => (waiting = false)}
          onpause={saveProgress}
          onended={onEnded}
          onerror={onError}
        ></video>
        {/key}
      {/if}

      <div class="surface" role="presentation" onpointerup={onSurfacePointerUp} ondblclick={onSurfaceDoubleClick}></div>

      {#if failure}
        <div class="center message">
          <p class="error">{failure}</p>
          <button onclick={() => load(fileId)}>다시 시도</button>
        </div>
      {:else if loading || waiting}
        <div class="center"><div class="spinner"></div></div>
      {:else if countdown > 0 && nextFile}
        <div class="center message">
          <p class="muted">{countdown}초 후 다음 영상</p>
          <p class="next-name">{nextFile.name}</p>
          <div class="actions">
            <button class="primary-btn" onclick={() => open(nextFile)}>지금 재생</button>
            <button onclick={cancelCountdown}>취소</button>
          </div>
        </div>
      {:else if paused && currentSrc}
        <button class="center big-play" onclick={togglePlay} aria-label="재생"><Icon name="play" size={44} /></button>
      {/if}

      {#if osd}
        <div class="osd">{osd}</div>
      {/if}

      <div class="top">
        <a class="icon-btn" href={folderHref(playlistFolderId)} aria-label="폴더로 돌아가기" title="폴더로 (Esc)">
          <Icon name="back" />
        </a>
        <span class="title">{file?.name ?? ''}</span>
      </div>

      <div class="bottom">
        <div
          class="seek"
          bind:this={seekEl}
          role="slider"
          tabindex="-1"
          aria-label="재생 위치"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration) || 0}
          aria-valuenow={Math.round(shownTime)}
          aria-valuetext={formatTime(shownTime)}
          onpointerdown={onSeekPointerDown}
          onpointermove={onSeekPointerMove}
          onpointerup={onSeekPointerEnd}
          onpointercancel={onSeekPointerEnd}
          onpointerleave={() => !scrubbing && (hoverRatio = null)}
        >
          <div class="track">
            <div class="buffered" style:width="{duration ? (bufferedEnd / duration) * 100 : 0}%"></div>
            <div class="played" style:width="{duration ? (shownTime / duration) * 100 : 0}%"></div>
          </div>
          <div class="thumb-dot" style:left="{duration ? (shownTime / duration) * 100 : 0}%"></div>
          {#if hoverRatio !== null && duration > 0}
            <div class="tip" style:left="{hoverRatio * 100}%">{formatTime(hoverRatio * duration)}</div>
          {/if}
        </div>

        <div class="buttons">
          <button class="icon-btn" onclick={() => open(prevFile)} disabled={!prevFile} aria-label="이전 영상" title="이전 영상 (Shift+P)">
            <Icon name="prev" />
          </button>
          <button class="icon-btn" onclick={togglePlay} aria-label={paused ? '재생' : '일시정지'} title="재생/일시정지 (Space)">
            <Icon name={paused ? 'play' : 'pause'} size={26} />
          </button>
          <button class="icon-btn" onclick={() => open(nextFile)} disabled={!nextFile} aria-label="다음 영상" title="다음 영상 (Shift+N)">
            <Icon name="next" />
          </button>

          <button class="icon-btn" onclick={toggleMute} aria-label="음소거" title="음소거 (M)">
            <Icon name={prefs.muted || prefs.volume === 0 ? 'muted' : 'volume'} />
          </button>
          <input
            class="volume"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={prefs.muted ? 0 : prefs.volume}
            oninput={(event) => setVolume(Number(event.currentTarget.value))}
            aria-label="볼륨"
          />

          <span class="clock">{formatTime(shownTime)} / {formatTime(duration)}</span>
          <span class="spacer"></span>

          {#if prefs.rate !== 1}
            <span class="rate-tag">{prefs.rate}x</span>
          {/if}
          <button class="icon-btn" onclick={() => (menuOpen = !menuOpen)} aria-label="설정" aria-expanded={menuOpen} title="설정">
            <Icon name="settings" />
          </button>
          {#if canPip}
            <button class="icon-btn" onclick={togglePip} aria-label="PIP" title="PIP (I)"><Icon name="pip" /></button>
          {/if}
          <button class="icon-btn" onclick={toggleFullscreen} aria-label="전체 화면" title="전체 화면 (F)">
            <Icon name={fullscreen ? 'fullscreenExit' : 'fullscreen'} />
          </button>
        </div>
      </div>

      {#if menuOpen}
        <div class="menu">
          <h3>재생 속도</h3>
          <div class="chips">
            {#each SPEEDS as speed (speed)}
              <button class:on={prefs.rate === speed} onclick={() => setRate(speed)}>{speed}x</button>
            {/each}
          </div>

          <h3>소스</h3>
          <div class="chips">
            {#each sources as source, index (source.label)}
              <button class:on={index === sourceIndex} onclick={() => selectSource(index)}>{source.label}</button>
            {/each}
          </div>

          <label><input type="checkbox" bind:checked={prefs.autoplayNext} /> 다음 영상 자동 재생</label>
          <label><input type="checkbox" bind:checked={prefs.loop} /> 반복 재생</label>
        </div>
      {/if}
    </div>

    <section class="info">
      <h1>{file?.name ?? ''}</h1>
      {#if file}
        <p class="muted">
          {[formatSize(file.size), formatDate(file.modified_time), sources[sourceIndex]?.label].filter(Boolean).join(' · ')}
        </p>
      {/if}
      {#if file}
        <button class="danger" onclick={trashCurrent}><Icon name="trash" size={16} />휴지통으로 이동</button>
      {/if}
      <details>
        <summary>단축키</summary>
        <dl>
          <dt>Space · K</dt><dd>재생/일시정지</dd>
          <dt>← →</dt><dd>5초 이동 (Shift: 30초)</dd>
          <dt>J · L</dt><dd>10초 이동</dd>
          <dt>0–9</dt><dd>해당 구간으로 이동</dd>
          <dt>↑ ↓ · M</dt><dd>볼륨 · 음소거</dd>
          <dt>[ ] · &lt; &gt;</dt><dd>재생 속도</dd>
          <dt>F · I</dt><dd>전체 화면 · PIP</dd>
          <dt>Shift+N · Shift+P</dt><dd>다음 · 이전 영상</dd>
          <dt>Esc</dt><dd>폴더로 돌아가기</dd>
        </dl>
      </details>
    </section>
  </div>

  {#if playlist.length > 1}
    <aside>
      <h2>이 폴더의 영상 <span class="muted">{position + 1} / {playlist.length}</span></h2>
      <ul>
        {#each playlist as item (item.id)}
          {@const entry = watch.entries[item.id]}
          <li class:current={item.id === fileId}>
            <a href={watchHref(playlistFolderId, item.id)} onclick={(event) => { event.preventDefault(); open(item) }}>
              <div class="mini">
                {#if item.thumbnail_link}
                  <img src={item.thumbnail_link} alt="" loading="lazy" />
                {/if}
                {#if durationOf(item) || entry?.duration}
                  <span class="mini-time">{formatTime(durationOf(item) || entry?.duration || 0)}</span>
                {/if}
                {#if watchedFraction(entry) > 0}
                  <div class="mini-bar" style:width="{watchedFraction(entry) * 100}%"></div>
                {/if}
              </div>
              <span class="mini-name">{item.name}</span>
            </a>
          </li>
        {/each}
      </ul>
    </aside>
  {/if}
</div>

<style>
  .page {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
    max-width: 1800px;
    margin: 0 auto;
    padding: 16px 20px 60px;
  }

  @media (min-width: 1200px) {
    .page {
      grid-template-columns: minmax(0, 1fr) 380px;
    }
  }

  .stage {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: calc(100vh - 150px);
    overflow: hidden;
    border-radius: 12px;
    background: #000;
    user-select: none;
    -webkit-user-select: none;
    touch-action: manipulation;
  }

  .stage:fullscreen {
    max-height: none;
    border-radius: 0;
  }

  .stage.idle {
    cursor: none;
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .surface {
    position: absolute;
    inset: 0;
  }

  .center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }

  .message {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    max-width: 80%;
    padding: 20px 24px;
    border-radius: 12px;
    background: rgb(0 0 0 / 0.75);
    text-align: center;
  }

  .message p {
    margin: 0;
  }

  .next-name {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    font-weight: 600;
    word-break: break-all;
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .primary-btn {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
  }

  .big-play {
    padding: 16px;
    border: none;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.6);
  }

  .spinner {
    width: 48px;
    height: 48px;
    border: 4px solid rgb(255 255 255 / 0.25);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    pointer-events: none;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .osd {
    position: absolute;
    top: 14%;
    left: 50%;
    transform: translateX(-50%);
    padding: 6px 14px;
    border-radius: 8px;
    background: rgb(0 0 0 / 0.7);
    font-size: 1.1rem;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  .top,
  .bottom {
    position: absolute;
    left: 0;
    right: 0;
    transition: opacity 0.2s;
  }

  .top {
    top: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px 28px;
    background: linear-gradient(rgb(0 0 0 / 0.7), transparent);
  }

  .bottom {
    bottom: 0;
    padding: 28px 12px 8px;
    background: linear-gradient(transparent, rgb(0 0 0 / 0.8));
  }

  .idle .top,
  .idle .bottom {
    opacity: 0;
    pointer-events: none;
  }

  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .seek {
    position: relative;
    height: 18px;
    cursor: pointer;
    touch-action: none;
  }

  .track {
    position: absolute;
    inset: 7px 0;
    overflow: hidden;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.25);
  }

  .seek:hover .track {
    inset: 6px 0;
  }

  .buffered,
  .played {
    position: absolute;
    inset: 0 auto 0 0;
  }

  .buffered {
    background: rgb(255 255 255 / 0.35);
  }

  .played {
    background: var(--accent);
  }

  .thumb-dot {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent);
    transform: translate(-50%, -50%) scale(0);
    transition: transform 0.1s;
  }

  .seek:hover .thumb-dot {
    transform: translate(-50%, -50%) scale(1);
  }

  .tip {
    position: absolute;
    bottom: 22px;
    transform: translateX(-50%);
    padding: 2px 7px;
    border-radius: 5px;
    background: rgb(0 0 0 / 0.85);
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
  }

  .buttons {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .volume {
    width: 80px;
    accent-color: #fff;
  }

  .clock {
    margin-left: 10px;
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
  }

  .rate-tag {
    padding: 1px 6px;
    border-radius: 5px;
    background: rgb(255 255 255 / 0.2);
    font-size: 0.78rem;
  }

  .menu {
    position: absolute;
    right: 12px;
    bottom: 64px;
    width: min(300px, calc(100% - 24px));
    max-height: calc(100% - 80px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: rgb(20 22 26 / 0.96);
  }

  .menu h3 {
    margin: 0;
    color: var(--muted);
    font-size: 0.78rem;
    font-weight: 500;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 4px;
  }

  .chips button {
    padding: 4px 10px;
    font-size: 0.85rem;
  }

  .chips button.on {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
  }

  .menu label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9rem;
  }

  .info {
    padding: 14px 2px 0;
  }

  h1 {
    margin: 0 0 4px;
    font-size: 1.2rem;
    line-height: 1.35;
    word-break: break-all;
  }

  .info p {
    margin: 0 0 12px;
    font-size: 0.88rem;
  }

  .danger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
    padding: 6px 12px;
    color: var(--danger);
    font-size: 0.88rem;
  }

  summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 0.88rem;
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 16px;
    margin: 10px 0 0;
    font-size: 0.85rem;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
  }

  aside h2 {
    margin: 0 0 10px;
    font-size: 1rem;
  }

  aside h2 span {
    margin-left: 6px;
    font-size: 0.85rem;
    font-weight: 400;
  }

  aside ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  @media (min-width: 1200px) {
    aside ul {
      max-height: calc(100vh - 80px);
      overflow-y: auto;
    }
  }

  aside a {
    display: flex;
    gap: 10px;
    padding: 6px;
    border-radius: 10px;
    color: inherit;
    text-decoration: none;
  }

  aside a:hover {
    background: var(--panel);
  }

  aside li.current a {
    background: var(--panel-hover);
  }

  .mini {
    position: relative;
    flex: 0 0 140px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: 8px;
    background: var(--panel);
  }

  .mini img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .mini-time {
    position: absolute;
    right: 4px;
    bottom: 6px;
    padding: 0 5px;
    border-radius: 4px;
    background: rgb(0 0 0 / 0.78);
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
  }

  .mini-bar {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 3px;
    background: var(--accent);
  }

  .mini-name {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    align-self: flex-start;
    font-size: 0.85rem;
    line-height: 1.35;
    word-break: break-all;
  }

  @media (max-width: 640px) {
    .page {
      padding: 0 0 40px;
    }

    .stage {
      border-radius: 0;
    }

    .info,
    aside {
      padding-left: 14px;
      padding-right: 14px;
    }

    .volume {
      display: none;
    }
  }
</style>
