import express from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { Writable } from 'stream';
import type { IncomingMessage } from 'http';
import routes from './routes';

/**
 * Resolves the built client's dist directory across layouts:
 *  - Packaged/bundled: main.cjs at <root>/dist-electron/, client at
 *    <root>/client/dist  => __dirname/../client/dist
 *  - Local monorepo (tsx): compiled or source server under <repo>/server/,
 *    client at <repo>/client/dist => __dirname/../../client/dist
 *  - cwd fallback for ad-hoc runs
 */
export function resolveClientDist(): string | null {
  const candidates = [
    path.join(__dirname, '../client/dist'),
    path.join(__dirname, '../../client/dist'),
    path.resolve(process.cwd(), 'client/dist'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/**
 * Subpath base (Docker reverse-proxy support). Read lazily inside createApp
 * via getBasePath() — see below. `BASE_PATH=/siren` serves the UI + API under
 * `/siren/` (`/siren/api/...`). Defaults to `/` (root) for Electron + direct
 * Docker runs. The client must be built with the same value as
 * VITE_BASE_PATH (see client/vite.config.ts + client/src/lib/base.ts).
 */
export function getBasePath(): string {
  let base = (process.env.BASE_PATH || '/').trim();
  if (!base.startsWith('/')) base = `/${base}`;
  if (base.length > 1) base = base.replace(/\/+$/, '');
  if (base === '') base = '/';
  return base;
}

/** Length-safe constant-time comparison for the loopback token. */
function tokensMatch(
  received: string | string[] | undefined,
  expected: string
): boolean {
  const value = Array.isArray(received) ? received[0] : received;
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Access log with size-based rotation. Rotation renames the active file to
 * `<name>.old` and reopens a fresh stream. On Windows a file with an open
 * write handle cannot be renamed, so rotation closes the stream first and
 * best-effort retries on the next cycle if the rename loses the race.
 */
function createRotatingAccessLog(logFile: string): Writable {
  let current: fs.WriteStream;

  const open = (): fs.WriteStream => {
    // Rotate at open time: no handle exists yet, so the rename always works.
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) {
        fs.renameSync(logFile, `${logFile}.old`);
      }
    } catch {
      // Best effort — keep logging into the existing file.
    }
    return fs.createWriteStream(logFile, { flags: 'a' });
  };

  current = open();

  const rotating = new Writable({
    write(chunk, _encoding, callback) {
      current.write(chunk, callback);
    },
  });

  setInterval(() => {
    try {
      if (!fs.existsSync(logFile) || fs.statSync(logFile).size <= MAX_LOG_BYTES) {
        return;
      }
      const old = current;
      old.end(() => {
        try {
          fs.renameSync(logFile, `${logFile}.old`);
        } catch {
          // Windows may still hold the handle briefly; retry next cycle.
        }
      });
      current = open();
    } catch {
      // Never let log maintenance break request handling.
    }
  }, 60 * 60 * 1000).unref();

  return rotating;
}

/**
 * Builds the configured Express app. All environment-dependent config is read
 * HERE (not at module top-level) so bundling main + server into one file
 * can't produce load-order bugs.
 *
 * Environment:
 *   SIREN_TOKEN     - when set, all /api routes require this header value
 *                     (injected by the Electron protocol handler; blocks
 *                     other local processes from using our proxy).
 *                     ELECTRON-ONLY: never set this in Docker — browsers have
 *                     no way to send it, so every /api call would 403. Docker
 *                     intentionally runs open and relies on the session cookie.
 *   SIREN_LOG_FILE  - when set, access logs go to this file instead of stdout
 *   NODE_ENV        - 'development' relaxes CSP for Vite dev injection
 *   BASE_PATH       - subpath mount (e.g. `/siren`) for reverse-proxy setups.
 *                     Must match the client's VITE_BASE_PATH build value.
 *                     Defaults to `/` (root).
 */
export function createApp(): express.Express {
  const app = express();
  const NODE_ENV = process.env.NODE_ENV || 'production';
  const BASE_PATH = getBasePath();
  const API_MOUNT = BASE_PATH === '/' ? '/api' : `${BASE_PATH}/api`;

  // Trust the upstream reverse-proxy hop count when Siren runs behind a TLS
  // reverse proxy (Caddy, Nginx, Traefik, ...). Leave unset (0) for direct
  // exposure. Needed so req.secure / rate-limiter client IPs are correct.
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));

  // Security headers. upgrade-insecure-requests is disabled: it rewrites
  // subresources to https:// which breaks plain-http serving, and is
  // pointless behind the app:// custom scheme. HSTS is likewise inert here.
  // originAgentCluster MUST stay off: the header crashes Chromium when the
  // renderer issues its next request on a non-standard scheme like app://
  // (the forwarder strips it defensively too — see electron/main.ts).
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          upgradeInsecureRequests: null,
          // Media (audio) and images stream through /api/proxy, so 'self'
          // covers them. Blob/data are needed for audio element edge cases.
          mediaSrc: ["'self'", 'blob:'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          // Vite dev server injects inline scripts/styles during development.
          ...(NODE_ENV === 'development'
            ? {
                scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
              }
            : {}),
        },
      },
      hsts: false,
      originAgentCluster: false,
    })
  );

  // Redact query strings from logs — only log req.path, never query params
  // (tokens/credentials must never hit disk). Route to a file in packaged
  // apps where stdout is invisible.
  morgan.token('url', (req: IncomingMessage) => {
    const url = req.url || '';
    return url.split('?')[0];
  });
  const logFile = process.env.SIREN_LOG_FILE;
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    app.use(morgan(':method :url :status', { stream: createRotatingAccessLog(logFile) }));
  } else {
    app.use(morgan(':method :url :status'));
  }

  // Health check (unauthenticated — used by tooling).
  // NOTE: Docker intentionally leaves this unauthenticated so the container
  // healthcheck works without a session. Only bind 0.0.0.0 when intended.
  app.get(`${API_MOUNT}/health`, (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Loopback token guard: when SIREN_TOKEN is set (always, in packaged
  // Electron builds), every API route requires the matching header. The
  // Electron protocol handler injects it; other local processes don't know
  // it, so they cannot use Siren as a proxy or attempt logins through it.
  // Docker/standalone never sets this (see env docs above).
  const expectedToken = process.env.SIREN_TOKEN;
  if (expectedToken) {
    app.use(API_MOUNT, (req, res, next) => {
      if (tokensMatch(req.headers['x-siren-token'], expectedToken)) return next();
      res.status(403).json({ error: 'Forbidden' });
    });
  }

  // API routes (order matters: auth before proxy)
  app.use(API_MOUNT, routes);

  // Serve the built client when present (packaged app + standalone prod).
  // Mounted at BASE_PATH so subpath builds resolve /<base>/assets/... and
  // /<base>/api/... from the same origin.
  const clientDistPath = resolveClientDist();
  if (clientDistPath) {
    console.log(`[siren] Serving client from ${clientDistPath} at ${BASE_PATH}`);
    if (BASE_PATH === '/') {
      app.use(express.static(clientDistPath, { index: false }));
    } else {
      app.use(BASE_PATH, express.static(clientDistPath, { index: false }));
      // Convenience: root redirects to the subpath so a bare host:port hit
      // doesn't 404 confusingly. (No redirect needed for the bare base
      // itself: express.static 301s directory paths to the trailing-slash
      // form, and an explicit app.get(BASE_PATH) would also match BASE_PATH
      // + '/' under non-strict routing and self-redirect forever.)
      app.get('/', (_req, res) => {
        res.redirect(`${BASE_PATH}/`);
      });
    }

    // SPA fallback — serve index.html for client-side routing.
    // Guard against accidentally swallowing unknown /api routes.
    const fallbackPattern = BASE_PATH === '/' ? '*' : `${BASE_PATH}/*`;
    app.get(fallbackPattern, (req, res, next) => {
      if (req.path === API_MOUNT || req.path.startsWith(`${API_MOUNT}/`)) {
        return next();
      }
      res.sendFile(path.join(clientDistPath, 'index.html'));
    });
  } else {
    console.warn('[siren] Client dist not found — static serving disabled.');
  }

  // 404 handler for unmatched API routes
  app.use(API_MOUNT, (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
