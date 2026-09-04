import { Router, Request, Response, raw, json } from 'express';
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
const CLIENT_VERSION = process.env.SIREN_APP_VERSION || '1.0.0';

function buildAuthHeader(deviceId: string): string {
  // Read lazily so bundling can't produce load-order bugs.
  const deviceName = process.env.SIREN_DEVICE_NAME || 'Siren Desktop';
  return `MediaBrowser Client="${CLIENT_NAME}", Device="${deviceName}", DeviceId="${deviceId}", Version="${CLIENT_VERSION}"`;
}

// ---------------------------------------------------------------------------
// URL validation
//
// Siren is a single-user desktop app: the proxy is only reachable from this
// machine (loopback bind + token header), so the old web-hosting SSRF threat
// model no longer applies. Users commonly run Jellyfin on localhost or
// another LAN box, so private/loopback targets are allowed. We keep a minimal
// guard: strict http/https protocol and link-local addresses (169.254.0.0/16,
// fe80::/10) which have no legitimate use here.
// ---------------------------------------------------------------------------

const BLOCKED_IPV4_RE = /^(169\.254\.|0\.)/;

function validateServerUrl(serverUrl: string): URL | null {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    const hostname = url.hostname.toLowerCase();
    if (BLOCKED_IPV4_RE.test(hostname)) {
      return null;
    }
    if (hostname.startsWith('fe80:')) {
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
            'X-Emby-Authorization': buildAuthHeader(deviceId),
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

      const session = createSession({
        serverUrl: validatedUrl.toString().replace(/\/$/, ''),
        token: data.AccessToken,
        deviceId,
        userId: data.User.Id,
        userName: data.User.Name,
      });

      // The renderer reaches us exclusively via the loopback server behind
      // the app:// protocol handler — there is no TLS hop to protect, and a
      // Secure flag risks rejection by the cookie jar on the custom scheme.
      res.cookie(SESSION_COOKIE_NAME, session.id, cookieOptions(false));

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
        return res.status(status).json({ error: `Jellyfin server error (${status})` });
      }
      if (axiosError.code === 'ECONNABORTED') {
        return res.status(504).json({ error: 'Server unreachable — check the URL and try again' });
      }
      return res.status(502).json({ error: 'Server unreachable — check the URL and try again' });
    }
  }
);

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
            'X-Emby-Token': session.token,
            'X-Emby-Authorization': buildAuthHeader(session.deviceId),
          },
          timeout: 5000,
        }
      );
    } catch {
      // Ignore — local session deletion proceeds either way.
    }
    deleteSession(session.id);
  }

  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions(false));
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
router.all('/proxy/:path(.*)?', raw({ type: '*/*', limit: '10mb' }), async (req: Request, res: Response) => {
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

  const validatedUrl = validateServerUrl(serverUrl);
  if (!validatedUrl) {
    return res.status(403).json({ error: 'Forbidden: invalid or blocked server URL' });
  }

  // Build target URL safely, preserving any base path of the server URL.
  // new URL(path, base) treats the base's final segment as a file, so a
  // server at https://host/jellyfin must resolve to https://host/jellyfin/Items/...
  const baseUrl = validatedUrl.toString().replace(/\/$/, '') + '/';
  const targetUrl = new URL(targetPath, baseUrl);

  // Sanitize query params: strip any proxy-specific params before forwarding.
  // (These should never be present anymore, but strip them defensively.)
  const params = new URLSearchParams(req.query as Record<string, string>);
  params.delete('X-Server-Url');
  params.delete('X-Emby-Token');
  targetUrl.search = params.toString();

  // Follow upstream redirects manually (bounded), re-validating every hop with
  // the same SSRF/self-loop checks so a redirect can never escape to a blocked
  // target. Previously maxRedirects: 0 turned any 3xx (subpath base URL, http→https
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
          signal: controller.signal,
          headers: {
            'X-Emby-Token': token,
            'X-Emby-Authorization': buildAuthHeader(deviceId),
            ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
            ...(req.headers['range'] ? { 'Range': req.headers['range'] } : {}),
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
      currentUrl = validatedNext;
    }
  } catch (error) {
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

  // Range-dependent responses must never be served across mismatched ranges
  // by an intermediate cache.
  const existingVary = res.getHeader('vary');
  if (!existingVary) {
    res.setHeader('Vary', 'Range');
  } else if (!String(existingVary).toLowerCase().includes('range')) {
    res.setHeader('Vary', `${existingVary}, Range`);
  }

  // Cache images for 24 hours
  if (targetPath.includes('/Images/') && !res.getHeader('cache-control')) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }

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