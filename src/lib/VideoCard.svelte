<script lang="ts">
  import Icon from './Icon.svelte'
  import { formatTime } from './format'

  interface Props {
    href: string
    name: string
    thumbnail?: string
    duration?: number
    /** 0–1 share already watched. */
    fraction?: number
    finished?: boolean
    meta?: string
    onRemove?: () => void
  }

  let { href, name, thumbnail = '', duration = 0, fraction = 0, finished = false, meta = '', onRemove }: Props =
    $props()

  let broken = $state(false)

  $effect(() => {
    void thumbnail
    broken = false
  })
</script>

<article>
  <a {href} title={name}>
    <div class="thumb">
      {#if thumbnail && !broken}
        <img src={thumbnail} alt="" loading="lazy" onerror={() => (broken = true)} />
      {:else}
        <div class="placeholder"><Icon name="play" size={36} /></div>
      {/if}
      {#if finished}
        <span class="badge done"><Icon name="check" size={13} />시청 완료</span>
      {/if}
      {#if duration > 0}
        <span class="badge time">{formatTime(duration)}</span>
      {/if}
      {#if fraction > 0}
        <div class="bar"><div style:width="{fraction * 100}%"></div></div>
      {/if}
    </div>
    <div class="name">{name}</div>
    {#if meta}
      <div class="meta">{meta}</div>
    {/if}
  </a>
  {#if onRemove}
    <button class="remove" onclick={onRemove} aria-label="시청 기록에서 삭제" title="시청 기록에서 삭제">
      <Icon name="close" size={16} />
    </button>
  {/if}
</article>

<style>
  article {
    position: relative;
    min-width: 0;
  }

  a {
    display: block;
    color: inherit;
    text-decoration: none;
  }

  .thumb {
    position: relative;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: 10px;
    background: var(--panel);
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 0.2s;
  }

  a:hover img {
    transform: scale(1.04);
  }

  .placeholder {
    height: 100%;
    display: grid;
    place-items: center;
    color: var(--border);
  }

  .badge {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: 5px;
    background: rgb(0 0 0 / 0.78);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .time {
    right: 6px;
    bottom: 8px;
  }

  .done {
    left: 6px;
    top: 6px;
  }

  .bar {
    position: absolute;
    inset: auto 0 0;
    height: 4px;
    background: rgb(255 255 255 / 0.25);
  }

  .bar div {
    height: 100%;
    background: var(--accent);
  }

  .name {
    margin-top: 8px;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    font-size: 0.9rem;
    line-height: 1.35;
    word-break: break-all;
  }

  .meta {
    margin-top: 2px;
    color: var(--muted);
    font-size: 0.78rem;
  }

  .remove {
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 4px;
    border: none;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.7);
    opacity: 0;
  }

  article:hover .remove,
  .remove:focus-visible {
    opacity: 1;
  }

  @media (hover: none) {
    .remove {
      opacity: 1;
    }
  }
</style>
