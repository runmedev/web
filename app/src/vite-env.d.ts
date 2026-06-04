/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RUNME_VERSION_BUILD_DATE?: string
  readonly VITE_RUNME_VERSION_WEB_REPO?: string
  readonly VITE_RUNME_VERSION_WEB_BRANCH?: string
  readonly VITE_RUNME_VERSION_WEB_COMMIT?: string
  readonly VITE_RUNME_VERSION_CODEX_REPO?: string
  readonly VITE_RUNME_VERSION_CODEX_BRANCH?: string
  readonly VITE_RUNME_VERSION_CODEX_COMMIT?: string
  readonly VITE_RUNME_VERSION_BUCKET?: string
}
