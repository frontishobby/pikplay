<script lang="ts" module>
  // History stores no thumbnail (the links expire), so fresh ones are fetched once per page load.
  const thumbnailCache = new Map<string, string>()
</script>

<script lang="ts">
  import VideoCard from './VideoCard.svelte'
  import { formatTime } from './format'
  import type { PikPak } from './pikpak'
  import { watchHref } from './router.svelte'
  import { forgetProgress, isFinished, watch, watchedFraction } from './store.svelte'

  const MAX_ITEMS = 12

  let { client }: { client: PikPak } = $props()

  let thumbnails = $state<Record<string, string>>(Object.fromEntries(thumbnailCache))

  const entries = $derived(
    Object.values(watch.entries)
      .filter((entry) => !isFinished(entry))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ITEMS),
  )

  $effect(() => {
    for (const entry of entries) {
      if (thumbnailCache.has(entry.id)) continue
      thumbnailCache.set(entry.id, '')
      client
        .detail(entry.id)
        .then((file) => {
          if (!file.thumbnail_link) return
          thumbnailCache.set(entry.id, file.thumbnail_link)
          thumbnails[entry.id] = file.thumbnail_link
        })
        .catch(() => {
          // A missing thumbnail only costs the picture; the card still works.
        })
    }
  })
</script>

{#if entries.length > 0}
  <section>
    <h2>이어보기</h2>
    <div class="row">
      {#each entries as entry (entry.id)}
        <div class="item">
          <VideoCard
            href={watchHref(entry.parentId, entry.id)}
            name={entry.name}
            thumbnail={thumbnails[entry.id]}
            fraction={watchedFraction(entry)}
            meta="{formatTime(entry.position)} / {formatTime(entry.duration)}"
            onRemove={() => forgetProgress(entry.id)}
            removeLabel="시청 기록에서 삭제"
          />
        </div>
      {/each}
    </div>
  </section>
{/if}

<style>
  section {
    margin-bottom: 28px;
  }

  h2 {
    margin: 0 0 12px;
    font-size: 1.05rem;
  }

  .row {
    display: flex;
    gap: 16px;
    overflow-x: auto;
    padding-bottom: 8px;
    scroll-snap-type: x proximity;
  }

  .item {
    flex: 0 0 min(260px, 70vw);
    scroll-snap-align: start;
  }
</style>
