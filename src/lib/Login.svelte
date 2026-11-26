<script lang="ts">
  import { PikPak } from './pikpak'

  let { client, onLogin }: { client: PikPak; onLogin: () => void } = $props()

  let token = $state('')
  let busy = $state(false)
  let error = $state('')

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    busy = true
    error = ''
    try {
      await client.login(token.trim())
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

    <p class="muted guide">
      <a href="https://mypikpak.com/drive/auth-center" target="_blank" rel="noreferrer">PikPak 계정 설정</a>의
      Account &amp; Security → Connected Apps → Personal Access Tokens에서 발급. 권한은 Read files면 충분합니다.
    </p>

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
      토큰은 로컬 프록시(127.0.0.1:8787)를 거쳐 PikPak으로만 전송되고, 이 브라우저의 localStorage에 저장됩니다.
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

  .guide {
    font-size: 0.88rem;
  }

  .note {
    font-size: 0.78rem;
  }
</style>
