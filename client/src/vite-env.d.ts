/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Subpath base (e.g. `/siren`). Defaults to `/`. See src/lib/base.ts. */
  readonly VITE_BASE_PATH?: string;
}
