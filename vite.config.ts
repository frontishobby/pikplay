import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig, type Plugin } from 'vite'
// @ts-expect-error plain .mjs without types
import { startProxy } from './proxy/server.mjs'

const PROXY_PORT = 8787

/**
 * Runs the local CORS relay alongside `vite dev`. Vite re-evaluates this file on
 * every config restart, so the relay lives on globalThis and is started once per
 * process rather than once per restart.
 */
function localCorsProxy(): Plugin {
  return {
    name: 'pikplay-local-cors-proxy',
    apply: 'serve',
    configureServer() {
      const shared = globalThis as { __pikplayProxy?: unknown }
      shared.__pikplayProxy ??= startProxy(PROXY_PORT)
    },
  }
}

export default defineConfig({
  plugins: [svelte(), localCorsProxy()],
})
