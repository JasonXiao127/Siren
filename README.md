# Siren

> This repo supersedes the archived `Siren-Web` and `Siren-Client` repos — desktop (Electron) and web (Docker) targets now live here together.

A clean, cross-platform **Jellyfin music client for the desktop**. Connect to
your Jellyfin server, browse albums/artists/playlists, search, favorite, and
stream music — built with Electron, React, and an embedded Node backend.

Your Jellyfin token is kept **out of the renderer**: it lives in the embedded
backend process behind a loopback-only connection with a per-launch token,
and the browser side authenticates with an httpOnly session cookie. Sessions
persist across app restarts.

## Download

Grab an installer from the
[Releases](../../releases) page (built by CI on every `v*` tag):

| Platform | Format |
| -------- | ------ |
| Windows  | NSIS installer (`.exe`) |
| macOS    | DMG (Intel + Apple Silicon) |
| Linux    | AppImage / `.deb` |

> **Builds are currently unsigned.** Expect a SmartScreen warning on Windows
> ("More info" → "Run anyway") and Gatekeeper friction on macOS (right-click →
> Open, or System Settings → Privacy & Security → "Open Anyway").

## Development

```bash
npm install
npm run dev        # esbuild watch + Vite HMR + Electron window
npm run typecheck  # typechecks electron/ + server/
npm run build      # builds client + bundles main/server processes
npm start          # runs the packaged-layout app locally (no installer)
```

`npm run dev` starts three things:

- **esbuild watch** — bundles `electron/main.ts` and `server/src/child.ts`
  into `dist-electron/`; any change restarts Electron.
- **Vite** — serves the React UI on `http://localhost:5177` (strict port)
  with HMR, proxying `/api` to the embedded server on `5176`.
- **Electron** — loads the Vite URL; the Express server runs inside a
  dedicated utility process owned by the Electron main process.

Desktop dev defaults: UI `5177`, API `5176` (so the frozen web archive at
`../Siren.WebArchive` can run side-by-side on `5174`/`5173` via
`npm run dev:both`).

## Web / Docker target

The same `server/` + `client/` codebase runs as a self-hosted web app:

```bash
docker compose up --build   # serves http://localhost:8080
npm run start:web           # local equivalent: serves server/dist + client/dist
```

- Container serves `server/dist/index.js` + static `client/dist` on `PORT 8080`
  (binds `0.0.0.0` when `NODE_ENV=production`; locally it stays loopback-only).
- Sessions are file-backed (`SIREN_DATA_DIR`, default `./data` locally,
  `/data` in the image). Compose mounts a named volume `siren-data:/data`
  so logins survive container recreation.
- Behind a TLS reverse proxy, set `TRUST_PROXY=1` so secure cookies and
  rate-limiter IPs are correct.

## Production architecture

```
┌─ Electron main process ─────────────────────────────┐
│  BrowserWindow ← stable origin app://siren          │
│  protocol.handle('app') ──▶ utilityProcess.fork     │
│                              Express server         │
│                              127.0.0.1:<ephemeral>  │
│                              sessions.json in       │
│                              userData               │
└─────────────────────────────────────────────────────┘
```

Why this shape:

- **Stable origin (`app://siren`)** — localStorage is origin-scoped *including
  port*, so an ephemeral `http://127.0.0.1:<port>` origin would wipe settings,
  deviceId, and login state every launch. The custom scheme is registered as
  standard + secure, giving a permanent origin and a secure context.
- **Server in a utility process** — a crash in the backend can't take down
  the window; streaming/proxy work never contends with the main-process event
  loop. The child is respawned with backoff if it dies.
- **Loopback token** — every `/api` request must carry a per-launch random
  header injected by the protocol handler, so other local processes can't use
  Siren as a proxy or attempt logins through it.
- **Session persistence** — logins survive restarts via atomic writes to
  `userData/sessions.json` (mode 0600 on POSIX; Windows uses default user
  ACLs), flushed synchronously on quit.

## Known limitations

- **Tokens at rest are plaintext.** `sessions.json` holds live Jellyfin
  access tokens unencrypted. The proper fix is OS-keychain integration
  (DPAPI / Keychain / libsecret), which requires a native dependency and
  breaks the zero-runtime-dependency packaging model — deferred until
  needed.
- **URL validation is hostname-based.** Blocked ranges (link-local) are
  matched against the literal hostname, not its resolved IP, so a DNS name
  resolving into a blocked range would pass. Acceptable for a token-gated,
  single-user desktop app.
- **Closing the window quits the app on all platforms**, including macOS
  (where convention keeps the app running in the dock).
- **Builds are unsigned** — see the install warnings above.

## Project layout

```
client/            React + Vite + Tailwind frontend (unchanged web codebase)
server/            Express API — auth, Jellyfin proxy, session persistence
electron/main.ts   Window lifecycle, app:// protocol handler, guards
packaging/         App icon sources (icon.ico/icon.png), picked up by electron-builder
scripts/dev.mjs    Dev orchestrator (esbuild watch + Vite + Electron)
scripts/build-electron.mjs  esbuild bundling (main.cjs + server.cjs)
scripts/gen-icon.cjs  Rasterizes client/public/siren.svg → packaging/ icons (`npm run icons`)
.github/workflows/build.yml  Cross-platform release builds (win/mac/linux)
```

## Packaging notes

- The app icon lives in `packaging/` (`icon.ico` multi-resolution + `icon.png`),
  generated from the UI logo by `npm run icons`. electron-builder embeds it in
  the executable automatically.
- The packaged app contains **only** `dist-electron/**` and `client/dist/**`
  — every runtime dependency is bundled into the two CJS files (the only
  external is `electron` itself). If you add a native dependency, mark it
  `external` in `scripts/build-electron.mjs` and add it to `asarUnpack` in
  `electron-builder.yml`.
- DMGs can only be built on macOS — use the CI workflow or a Mac for that
  target (`npm run dist:mac`).
- Code signing hooks are stubbed in CI (`CSC_IDENTITY_AUTO_DISCOVERY=false`);
  set `CSC_LINK`/`CSC_KEY_PASSWORD` secrets when certificates are available.

## Security notes

- Jellyfin credentials go only to *your* Jellyfin server (through the local
  proxy) — never anywhere else.
- Session cookies are httpOnly; the Jellyfin access token never enters the
  renderer, URLs, or logs (query strings are redacted from access logs).
- The proxy validates upstream URLs (http/https only, link-local blocked) and
  re-validates every redirect hop.
