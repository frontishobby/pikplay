<script lang="ts">
  import Library from './lib/Library.svelte'
  import Login from './lib/Login.svelte'
  import Player from './lib/Player.svelte'
  import { clearFolderCache } from './lib/library'
  import { PikPak } from './lib/pikpak'
  import { router } from './lib/router.svelte'
  import { clearHistory, savePrefs } from './lib/store.svelte'

  const client = new PikPak()
  let loggedIn = $state(client.loggedIn)

  function logout() {
    client.logout()
    clearHistory()
    clearFolderCache()
    loggedIn = false
  }

  // savePrefs reads every preference, so any change to one re-runs this.
  $effect(savePrefs)
</script>

{#if !loggedIn}
  <Login {client} onLogin={() => (loggedIn = true)} />
{:else if router.route.view === 'watch'}
  <Player {client} fileId={router.route.fileId} folderId={router.route.folderId} />
{:else}
  <Library {client} folderId={router.route.folderId} onLogout={logout} />
{/if}
