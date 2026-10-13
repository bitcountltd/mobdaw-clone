/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' in builds that talk to the Node server (accounts, cloud projects, sharing, chat). Unset in the static build. */
  readonly VITE_CLOUD?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
