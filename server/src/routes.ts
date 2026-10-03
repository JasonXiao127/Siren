import { Router, Request, Response, NextFunction, raw, json } from 'express';
import axios, { AxiosError, AxiosResponse } from 'axios';
import rateLimit from 'express-rate-limit';
import { LoginRequest, JellyfinAuthResponse, LoginSuccessResponse } from './types';
import {
  createSession,
  deleteSession,
  getSession,
  parseCookies,
  cookieOptions,
  SESSION_COOKIE_NAME,
} from './session';

const router = Router();

const CLIENT_NAME = 'Siren';
// Kept in sync with the app version via the SIREN_APP_VERSION esbuild define
// (see scripts/build-electron.mjs); falls back for standalone runs.
const CLIENT_VERSION_RAW = process.env.SIREN_APP_VERSION || '1.1.1';

// Jellyfin 12 requires the modern `Authorization: MediaBrowser …` header.
// Legacy methods (X-Emby-Authorization, X-Emby-Token, X-MediaBrowser-Token,
// api_key) are disabled by default (EnableLegacyAuthorization=false) and will
// be removed entirely in a future release. This header shape works back to
// Jellyfin 10.8, but Siren officially targets 12+ only.
function sanitizeHeaderValue(value: string, maxLen = 64): string {
  return value.replace(/["\r\n,]/g, '').slice(0, maxLen);
}

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function buildAuthorizationHeader(deviceId: string, token?: string): string {
  // Read lazily so bundling can't produce load-order bugs.
  const deviceName = sanitizeHeaderValue(process.env.SIREN_DEVICE_NAME || 'Siren Desktop');
  const safeDeviceId = sanitizeHeaderValue(deviceId);
  const safeVersion = sanitizeHeaderValue(CLIENT_VERSION_RAW, 32);
  const base =
    `MediaBrowser Client="${CLIENT_NAME}", Device="${deviceName}", DeviceId="${safeDeviceId}", Version="${safeVersion}"`;
  return token ? `${base}, Token="${sanitizeHeaderValue(token, 256)}"` : base;
}

// ---------------------------------------------------------------------------
// URL validation
//
// Per-target threat model: on desktop the proxy is only reachable from this
// machine (loopback bind + per-launch token header), single-user. In Docker
// it is network-reachable and cookie-only, so treat it as web-hosted —
// except that users self-host Jellyfin on localhost or another LAN box, so
// private/loopback targets are allowed anyway. Either way we keep a minimal
// guard: strict http/https protocol and link-local addresses (169.254.0.0/16,
// fe80::/10) which have no legitimate use here. Every redirect hop is
// re-validated before following.
// ---------------------------------------------------------------------------

const BLOCKED_IPV4_RE = /^(169\.254\.|0\.)/;

/** Same host:port and same scheme, or an http→https upgrade (never downgrade). */
function isSameOriginOrUpgrade(base: URL, next: URL): boolean {
  if (base.host !== next.host) return false;
  if (base.protocol === next.protocol) return true;
  return base.protocol === 'http:' && next.protocol === 'https:';
}

function validateServerUrl(serverUrl: string): URL | null {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    // Reject embedded credentials — they would persist into session.serverUrl
    // and be sent to axios on every proxied request.
    if (url.username || url.password) {
      return null;
    }
    // Node's URL.hostname retains brackets for IPv6 literals ([fe80::1]).
    // Strip them for the link-local check, and enforce the full fe80::/10
    // range (fe80–febf), not just the fe80: prefix.
    const rawHost = url.hostname.toLowerCase();
    const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
    if (BLOCKED_IPV4_RE.test(host)) {
      return null;
    }
    // Bare "0" (→ 0.0.0.0) doesn't match /^0\./ but dials the wildcard.
    if (host === '0' || host === '0.0.0.0') {
      return null;
    }
    if (/^(fe[89ab][0-9a-f]*:)/.test(host)) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // 20 login attempts per 15 min per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// POST /api/auth/login
router.post(
  '/auth/login',
  loginLimiter,
  json({ limit: '10kb' }),
  async (req: Request, res: Response) => {
    const { serverUrl, username, password, deviceId } = req.body as LoginRequest;

    if (!serverUrl || !username || !password || !deviceId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
      return res.status(400).json({ error: 'Invalid device ID' });
    }

    const validatedUrl = validateServerUrl(serverUrl);
    if (!validatedUrl) {
      return res.status(400).json({ error: 'Invalid server URL' });
    }

    try {
      const response = await axios.post<JellyfinAuthResponse>(
        `${validatedUrl.toString().replace(/\/$/, '')}/Users/AuthenticateByName`,
        {
          Username: username,
          Pw: password,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': buildAuthorizationHeader(deviceId),
          },
          timeout: 10000,
        }
      );

      const data = response.data as JellyfinAuthResponse | undefined;
      // Validate the upstream shape: a captive portal, proxy page, or
      // unexpected Jellyfin version would otherwise throw mid-handler and
      // leave the request hanging forever (Express 4 doesn't catch async
      // throws).
      if (
        !data ||
        typeof data.AccessToken !== 'string' ||
        !data.User ||
        typeof data.User.Id !== 'string' ||
        typeof data.User.Name !== 'string'
      ) {
        return res.status(502).json({ error: 'Unexpected response from Jellyfin server' });
      }

      const { session, replaced } = createSession({
        serverUrl: validatedUrl.toString().replace(/\/$/, ''),
        token: data.AccessToken,
        deviceId,
        userId: data.User.Id,
        userName: data.User.Name,
      });
      // Revoke orphaned Jellyfin tokens from replaced/LRU-evicted rows so
      // re-login doesn't leave live tokens until Jellyfin-side expiry.
      // Best-effort, don't block login.
      for (const old of replaced) {
        void axios
          .post(
            `${old.serverUrl}/Sessions/Logout`,
            {},
            {
              headers: { Authorization: buildAuthorizationHeader(old.deviceId, old.token) },
              timeout: 5000,
            }
          )
          .catch(() => undefined);
      }

      // The renderer reaches us exclusively via the loopback server behind
      // the app:// protocol handler — there is no TLS hop to protect, and a
      // Secure flag risks rejection by the cookie jar on the custom scheme.
      // Behind a TLS-terminating proxy req.secure is true (requires TRUST_PROXY),
      // so the cookie gets Secure there automatically.
      res.cookie(SESSION_COOKIE_NAME, session.id, cookieOptions(req.secure === true));

      const result: LoginSuccessResponse = {
        user: {
          id: data.User.Id,
          name: data.User.Name,
        },
        serverUrl: session.serverUrl,
      };

      return res.json(result);
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError.response) {
        const status = axiosError.response.status;
        if (status === 401) {
          return res.status(401).json({ error: 'Invalid username or password' });
        }
        if (status === 404) {
          return res.status(404).json({ error: 'Server not found — check the URL' });
        }
        // Don't reflect arbitrary upstream statuses (may leak internals);
        // normalize to a generic bad-gateway.
        return res.status(502).json({ error: 'Jellyfin server error — please try again' });
      }
      if (axiosError.code === 'ECONNABORTED') {
        return res.status(504).json({ error: 'Server unreachable — check the URL and try again' });
      }
      return res.status(502).json({ error: 'Server unreachable — check the URL and try again' });
    }
  }
);

// GET /api/auth/session — boot probe: validates the httpOnly cookie without
// exposing the token. Lets the client gate ProtectedLayout on the real
// server session instead of localStorage alone (avoids authed-UI flash).
router.get('/auth/session', (req: Request, res: Response) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  const session = sessionId ? getSession(sessionId) : null;
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.json({ user: { id: session.userId, name: session.userName }, serverUrl: session.serverUrl });
});

// POST /api/auth/logout
router.post('/auth/logout', async (req: Request, res: Response) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  const session = sessionId ? getSession(sessionId) : null;

  if (session) {
    // Best-effort revocation of the Jellyfin access token so it can't be
    // used after logout. Failures (server down, already revoked) are fine —
    // the token expires on Jellyfin's side eventually regardless.
    try {
      await axios.post(
        `${session.serverUrl}/Sessions/Logout`,
        {},
        {
          headers: {
            'Authorization': buildAuthorizationHeader(session.deviceId, session.token),
          },
          timeout: 5000,
        }
      );
    } catch {
      // Ignore — local session deletion proceeds either way.
    }
    deleteSession(session.id);
  }

  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions(req.secure === true));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

function destroyStream(data: unknown): void {
  const stream = data as { destroy?: () => void } | null;
  if (stream && typeof stream.destroy === 'function') {
    stream.destroy();
  }
}

// ALL /api/proxy/:path(.*)?
const PROXY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
// Cheap pre-parse auth gate: raw() would buffer up to 10mb before the
// handler runs, so reject anonymous callers first to avoid unauthenticated
// resource burn. Full session validation stays in-handler.
function proxyPreAuth(req: Request, res: Response, next: NextFunction): void {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  next();
}
router.all(
  '/proxy/:path(.*)?',
  proxyPreAuth,
  raw({ type: '*/*', limit: '10mb' }),
  async (req: Request, res: Response) => {
  if (!PROXY_METHODS.has(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Resolve auth from the server-side session cookie ONLY. Never from query
  // params — that would leak the Jellyfin token into URLs, browser history,
  // and access logs.
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  const session = sessionId ? getSession(sessionId) : null;

  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { serverUrl, token, deviceId } = session;

  // Extract target path
  const rawPath = req.params.path;
  const pathStr = Array.isArray(rawPath) ? rawPath.join('/') : (rawPath || '');
  const targetPath = pathStr.replace(/^\//, '');

  if (!targetPath) {
    return res.status(404).json({ error: 'Not found' });
  }

  const validatedUrl = validateServerUrl(serverUrl);
  if (!validatedUrl) {
    return res.status(403).json({ error: 'Forbidden: invalid or blocked server URL' });
  }
  const serverBasePath = validatedUrl.pathname.replace(/\/$/, '');

  // Build target URL safely, preserving any base path of the server URL.
  // new URL(path, base) treats the base's final segment as a file, so a
  // server at https://host/jellyfin must resolve to https://host/jellyfin/Items/...
  const baseUrl = validatedUrl.toString().replace(/\/$/, '') + '/';
  const targetUrl = new URL(targetPath, baseUrl);
  // Pin the initial target to the Jellyfin origin: an absolute-URL targetPath
  // (https://evil/x, //evil/x) would otherwise discard baseUrl per WHATWG
  // and exfiltrate the Jellyfin token to an attacker host. Same check as
  // redirects below. Also reject embedded credentials in the resolved URL.
  // Allow http→https upgrades on the same host:port (common Jellyfin setup),
  // never https→http downgrades.
  if (!isSameOriginOrUpgrade(validatedUrl, targetUrl)) {
    return res.status(403).json({ error: 'Forbidden: invalid request path' });
  }
  if (targetUrl.username || targetUrl.password) {
    return res.status(403).json({ error: 'Forbidden: invalid request path' });
  }
  // Prevent subpath escape (e.g. ../x escaping a /jellyfin base).
  if (serverBasePath && !targetUrl.pathname.startsWith(serverBasePath + '/') && targetUrl.pathname !== serverBasePath) {
    return res.status(403).json({ error: 'Forbidden: invalid request path' });
  }

  // Sanitize query params: strip any proxy-specific or legacy-auth params
  // before forwarding. Never forward a token via query — auth travels in the
  // Authorization header only (query tokens leak into logs/history). Also
  // strip ApiKey/api_key defensively so a stray param can't cause a
  // dual-auth 401 on Jellyfin 12+. Case-insensitive: URLSearchParams.delete
  // is case-sensitive, so normalize first.
  const rawParams = new URLSearchParams(req.query as Record<string, string>);
  const STRIP_PARAM_RE = /^(api[_-]?key|.*token|.*authorization|x-server-url)$/i;
  const params = new URLSearchParams();
  for (const [key, value] of rawParams) {
    if (STRIP_PARAM_RE.test(key)) continue;
    params.append(key, value);
  }
  targetUrl.search = params.toString();

  // Follow upstream redirects manually (bounded), re-validating every hop with
  // the same SSRF/self-loop checks so a redirect can never escape to a blocked
  // target. Redirects are pinned to the Jellyfin server origin: a compromised
  // server or MITM must not be able to bounce the proxy to an arbitrary
  // LAN/loopback host. Previously maxRedirects: 0 turned any 3xx (subpath base URL, http→https
  // upgrade, trailing-slash normalization) into a bodiless error response,
  // which broke every <img> and JSON call for such setups.
  const MAX_REDIRECTS = 5;
  // Abort if upstream doesn't produce response headers within this window —
  // a hung Jellyfin connection would otherwise hold the socket forever. The
  // timer is cleared once headers arrive so long audio streams are untouched.
  const HEADER_TIMEOUT_MS = 20000;
  let currentUrl: URL = targetUrl;
  let response: AxiosResponse | null = null;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const controller = new AbortController();
      const headerTimer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
      let hopResponse: AxiosResponse;
      try {
        hopResponse = await axios({
          method: req.method,
          url: currentUrl.toString(),
          responseType: 'stream',
          validateStatus: () => true,
          maxRedirects: 0,
          // Preserve raw bytes so forwarded Content-Length/Content-Encoding
          // stay consistent with the actual body.
          decompress: false,
          signal: controller.signal,
          headers: {
            'Authorization': buildAuthorizationHeader(deviceId, token),
            ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
            ...(req.headers['range'] ? { 'Range': req.headers['range'] } : {}),
            ...(req.headers['if-none-match'] ? { 'If-None-Match': req.headers['if-none-match'] } : {}),
            ...(req.headers['if-modified-since'] ? { 'If-Modified-Since': req.headers['if-modified-since'] } : {}),
            ...(req.headers['if-range'] ? { 'If-Range': req.headers['if-range'] } : {}),
          },
          data: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
        });
      } finally {
        // Headers received (or the attempt failed) — never abort mid-stream.
        clearTimeout(headerTimer);
      }
      response = hopResponse;

      const status = hopResponse.status;
      const location = hopResponse.headers.location;
      const isRedirect = status >= 300 && status < 400 && !!location;

      if (!isRedirect) {
        break;
      }

      // Redirect: discard the empty body, validate the next hop, and retry.
      // Pinned to the Jellyfin origin so a 302 cannot bounce to arbitrary hosts.
      destroyStream(hopResponse.data);
      let nextUrl: URL | null = null;
      try {
        nextUrl = new URL(location as string, currentUrl);
      } catch {
        nextUrl = null;
      }
      const validatedNext = nextUrl ? validateServerUrl(nextUrl.toString()) : null;
      if (!validatedNext) {
        return res.status(502).json({ error: 'Bad gateway: upstream redirect target blocked' });
      }
      if (!isSameOriginOrUpgrade(validatedUrl, validatedNext)) {
        return res.status(502).json({ error: 'Bad gateway: upstream redirect target blocked' });
      }
      if (serverBasePath && !validatedNext.pathname.startsWith(serverBasePath + '/') && validatedNext.pathname !== serverBasePath) {
        return res.status(502).json({ error: 'Bad gateway: upstream redirect target blocked' });
      }
      currentUrl = validatedNext;
    }
    // Still redirecting after MAX_REDIRECTS+1 fetches — don't relay a bodiless 3xx.
    if (response && response.status >= 300 && response.status < 400) {
      destroyStream(response.data);
      return res.status(502).json({ error: 'Bad gateway: too many redirects' });
    }
  } catch (error) {
    if (res.headersSent || res.writableEnded) return;
    const axiosError = error as AxiosError;
    if (
      axiosError.code === 'ERR_CANCELED' ||
      axiosError.code === 'ECONNABORTED'
    ) {
      // Header timeout fired — upstream accepted the connection but never
      // responded.
      return res.status(504).json({ error: 'Bad gateway: Jellyfin server timed out' });
    }
    if (axiosError.response) {
      // Forward error status and body
      res.status(axiosError.response.status);
      if (axiosError.response.data && typeof (axiosError.response.data as { pipe?: unknown }).pipe === 'function') {
        (axiosError.response.data as NodeJS.ReadableStream).pipe(res);
      } else {
        res.json({ error: `Upstream error: ${axiosError.response.status}` });
      }
      return;
    }
    return res.status(502).json({ error: 'Bad gateway: could not reach Jellyfin server' });
  }

  if (!response) {
    return res.status(502).json({ error: 'Bad gateway: could not reach Jellyfin server' });
  }

  // Reserve bare 401 for "no/invalid Siren session" (handled above). An
  // upstream Jellyfin 401 (revoked token, password change) must not trigger
  // the client's 401 → logout → /login interceptor, so map it to 502.
  if (response.status === 401) {
    destroyStream(response.data);
    return res.status(502).json({ error: 'Jellyfin rejected the request — please log in again' });
  }

  // Forward status
  res.status(response.status);

  // Forward key headers
  const headersToForward = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'cache-control',
    'etag',
    'last-modified',
    'expires',
    'content-disposition',
    'content-encoding',
  ];

  for (const header of headersToForward) {
    const value = response.headers[header];
    if (value !== undefined) {
      res.setHeader(header, value as string);
    }
  }

  // Accept-Ranges is forwarded from upstream verbatim (see headersToForward)
  // and deliberately NOT injected when absent: direct-played files get it
  // truthfully from Jellyfin's static handler, but transcoded output is a
  // live pipe that ignores Range requests — advertising bytes support there
  // makes the player issue ranged seeks that restart the stream from zero.

  // Cache images for 24 hours (browser-only: auth is cookie-based, so a
  // shared cache must not serve one user's art to another). Force private
  // even if upstream sends public — Vary: Cookie backstops compliant caches
  // but the combination is contradictory.
  if (/\/Items\/[^/]+\/Images\//.test(targetPath)) {
    res.setHeader('Cache-Control', 'private, max-age=86400');
  }
  // Authenticated responses vary on Cookie so shared caches don't mix users.
  const varyValues = new Set(
    String(res.getHeader('vary') || '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  );
  varyValues.add('range');
  varyValues.add('cookie');
  // Title-case Vary members for readability; values are case-insensitive.
  const varyOut = [...varyValues].map((v) => (v === 'cookie' ? 'Cookie' : v === 'range' ? 'Range' : v));
  res.setHeader('Vary', varyOut.join(', '));

  // Stream with explicit error handling. If the renderer navigates away or
  // reloads mid-stream, `res` closes while the upstream pipe is active —
  // without these handlers the resulting EPIPE/aborted-stream errors surface
  // as uncaught exceptions (fatal in the Electron child process).
  response.data.on('error', () => {
    destroyStream(response?.data);
    if (!res.writableEnded) {
      res.destroy();
    }
  });
  res.on('close', () => {
    destroyStream(response?.data);
  });

  // Pipe the stream
  response.data.pipe(res);
});

export default router;