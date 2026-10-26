/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/**
 * Injected by vite.config.mjs from packages/client/package.json.
 * Single source of truth for the version shown in the UI — there is no second
 * "engine version" any more (it drifted from 0.4.0 while the app went to 1.2.3).
 */
declare const __APP_VERSION__: string
