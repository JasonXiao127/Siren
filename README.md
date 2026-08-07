# Siren 🎧

A Spotify-like **Jellyfin music web client**. Connect to your Jellyfin server,
browse albums/artists/playlists, search, favorite, and stream music — all from
a clean, self-hosted web UI. The Jellyfin token is kept **server-side** in an
httpOnly session cookie and is never exposed in the browser or in URLs.

## Run with Docker Compose

The pre-built image is published to Docker Hub — no source code or Node needed.
Just save the file below as `docker-compose.yml` and run `docker compose up -d`:

```yaml
services:
  siren:
    image: maraudermarauder/siren:1.0.0
    container_name: siren
    ports:
      - "5173:5173"
    environment:
      - PORT=5173
      - NODE_ENV=production
      # Set TRUST_PROXY=1 when running behind a TLS reverse proxy (Caddy,
      # Nginx, Traefik). Keeps the session cookie 'secure' and the login
      # rate-limiter on real client IPs.
      - TRUST_PROXY=0
    restart: unless-stopped
```

Then open **http://localhost:5173** and sign in with your Jellyfin server URL,
username, and password.

> Your Jellyfin **server address and credentials are entered at login by each
> user** — nothing is baked into the image, and the password only ever travels
> to *your* Jellyfin server (through the proxy), never to Docker Hub or Siren.

### Configuration

| Environment variable | Default | Description |
| -------------------- | ------- | ----------- |
| `PORT`               | `5173`  | HTTP port the server listens on. |
| `NODE_ENV`           | `development` | `production` disables dev-only CSP relaxations and serves the built client. |
| `TRUST_PROXY`        | `0`     | Number of reverse-proxy hops to trust. Set to `1` (or higher) behind a TLS reverse proxy so the session cookie is set `secure` and the login rate-limiter uses real client IPs. |

### Securing it publicly

- Put Siren **behind a TLS reverse proxy** (Caddy/Nginx/Traefik) with it bound to
  `127.0.0.1:5173` only, and set `TRUST_PROXY=1`.
- The container already runs as a **non-root user** and ships with a
  `HEALTHCHECK` against `/api/health`.
- Login is rate-limited (20 attempts / 15 min per IP).

## Local development

```bash
npm install
npm run dev        # Express server (:5173) + Vite dev UI (:5174)
npm run build      # type-checks + builds both workspaces
npm start          # runs the built server in production mode
```

> During `npm run dev`, the Vite dev server uses **5174** and proxies `/api` to
> the Express server on **5173** so the two never collide. In production the
> single container serves both the API and the built client on **5173**.

## Project layout

```
client/   React + Vite + Tailwind frontend
server/   Express API — auth, Jellyfin proxy, and static file serving
Dockerfile         multi-stage image (builder → slim runner, non-root)
docker-compose.yml pinned compose file
```

## Security notes & limitations

- **Session store is in-memory**: users must sign in again after the container
  restarts, and multi-replica deployments need a shared session store. This is
  fine for a single-instance home setup.
- **No scope creep**: rate-limit counts and sessions live per-instance.
- The proxy is hardened against SSRF/self-loop (blocks link-local / loopback /
  cloud-metadata addresses) and re-validates every redirect hop.
