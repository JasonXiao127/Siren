# Siren

A Jellyfin music client. Connect to your Jellyfin server and browse, search,
and stream your library. Ships as a desktop app (Electron) and a self-hosted
web app (Docker) from this one repo.

## Download

Installers are built on every `v*` tag — see [Releases](../../releases):

| Windows | macOS | Linux |
| ------- | ----- | ----- |
| `.exe` (NSIS) | `.dmg` (Intel + Apple Silicon) | AppImage / `.deb` |

Builds are unsigned. On Windows click "More info" → "Run anyway". On macOS
right-click → Open, or allow it under Privacy & Security.

## Requirements

- Jellyfin **12+** is required. Jellyfin 10.11 is not officially supported:
  it is untested and may stop working at any time — if it breaks, it breaks.
- After upgrading your Jellyfin server to 12, run a **full library scan**
  from the dashboard (required by the Jellyfin 12 upgrade itself before
  artists and artwork settle).

## Development

```bash
npm install
npm run dev        # esbuild watch + Vite HMR + Electron window
npm run typecheck  # typechecks electron/ + server/ + client/
npm run build      # builds client + bundles main/server processes
npm start          # runs the packaged-layout app locally (no installer)
```

Dev runs the UI on `5177` and the API on `5176`.

## Docker

```bash
docker compose up --build   # serves http://localhost:8080
npm run start:web           # local equivalent (needs a server build first)
```

- Logins persist in a `siren-data` volume (`/data` in the container).
- Behind a TLS proxy, set `TRUST_PROXY=1`.
- Never set `SIREN_TOKEN` here — it's Electron-only and would block every
  browser request.

### Subpath hosting (e.g. `/siren`)

The proxy must pass the prefix through, not strip it. Client and server must
use the same base:

```bash
VITE_BASE_PATH=/siren npm run build --workspace=@siren/client
npm run build --workspace=@siren/server
BASE_PATH=/siren npm run start:web   # serves http://127.0.0.1:5176/siren/

docker compose build --build-arg BASE_PATH=/siren
BASE_PATH=/siren docker compose up   # serves http://localhost:8080/siren/
```

```
# Caddy: preserve the prefix
handle /siren* {
    reverse_proxy 127.0.0.1:8080
}
```

Dev stays root-only; subpath is for prod builds.

## How it works

- The desktop app serves the UI from `app://siren`, a fixed origin so
  settings and login survive restarts.
- The Express server runs in its own process, so a backend crash can't kill
  the window.
- On desktop, every API call carries a per-launch token only the app knows,
  so other local programs can't abuse the proxy.
- Your Jellyfin token stays in the backend; the browser uses an httpOnly
  session cookie. Logins are saved to `sessions.json` and survive restarts.

## Limitations

- Tokens on disk are plaintext (`sessions.json`). Keychain support needs a
  native dependency, so it's deferred.
- URL blocklists match hostnames, not resolved IPs.
- Closing the window quits the app, even on macOS.
- Builds are unsigned (see above).

## Layout

```
client/            React + Vite + Tailwind frontend
server/            Express API — auth, Jellyfin proxy, sessions
electron/main.ts   Window, app:// handler, server process
packaging/         App icons (`npm run icons` to regenerate)
scripts/           dev.mjs, build-electron.mjs, gen-icon.cjs, test-sessions.mjs
.github/workflows/build.yml  Release builds (win/mac/linux installers + Docker image)
```

## Notes

- The packaged app bundles all dependencies into two files — no runtime
  `node_modules`. A native dependency would need `external` in
  `build-electron.mjs` plus `asarUnpack` in `electron-builder.yml`.
- DMGs build on macOS only — use CI or a Mac. Signing is stubbed out until
  certificates exist (`CSC_LINK` / `CSC_KEY_PASSWORD`).
- Credentials go only to your Jellyfin server. Tokens never appear in URLs
  or logs; proxied URLs are validated on every redirect hop.
