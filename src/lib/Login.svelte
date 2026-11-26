<script lang="ts">
  import { untrack } from 'svelte'
  import { PikPak } from './pikpak'

  let { client, onLogin }: { client: PikPak; onLogin: () => void } = $props()

  let relay = $state(untrack(() => client.relay))
  let token = $state('')
  let busy = $state(false)
  let error = $state('')

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    busy = true
    error = ''
    try {
      await client.login(relay.trim(), token.trim())
      onLogin()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

<main>
  <form onsubmit={submit}>
    <h1>pikplay</h1>

    <label>
      <span>릴레이 주소 (Supabase Edge Function)</span>
      <input
        bind:value={relay}
        type="url"
        placeholder="https://<project>.supabase.co/functions/v1/pikplay"
        autocomplete="url"
        required
        disabled={busy}
        spellcheck="false"
      />
    </label>

    <label>
      <span>Personal Access Token</span>
      <input bind:value={token} type="password" autocomplete="off" required disabled={busy} spellcheck="false" />
    </label>

    <button class="primary" type="submit" disabled={busy}>
      {busy ? '확인 중…' : '로그인'}
    </button>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <p class="muted note">
      토큰은 <a href="https://mypikpak.com/drive/auth-center" target="_blank" rel="noreferrer">PikPak 계정 설정</a>의
      Connected Apps → Personal Access Tokens에서 발급합니다(Read files 권한이면 충분). 릴레이는 여기 넣은 토큰이 자신에게
      등록된 토큰과 같을 때만 요청을 받아줍니다. 주소와 토큰은 이 브라우저의 localStorage에만 저장됩니다.
    </p>
  </form>
</main>

<style>
  main {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  form {
    width: min(420px, 100%);
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 28px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--panel);
  }

  h1 {
    margin: 0;
    font-size: 1.6rem;
  }

  p {
    margin: 0;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.85rem;
    color: var(--muted);
  }

  input {
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    font-size: 1rem;
  }

  input:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }

  .note {
    font-size: 0.78rem;
  }
</style>
