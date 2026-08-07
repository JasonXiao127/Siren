import { Router, Request, Response, raw, json } from 'express';
import axios, { AxiosError, AxiosResponse } from 'axios';
import os from 'os';
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
const CLIENT_VERSION = '1.0.0';
const DEVICE_NAME = 'Web Browser';

function buildAuthHeader(deviceId: string): string {
  return `MediaBrowser Client="${CLIENT_NAME}", Device="${DEVICE_NAME}", DeviceId="${deviceId}", Version="${CLIENT_VERSION}"`;
}

// ---------------------------------------------------------------------------
// SSRF / self-loop protection
// ---------------------------------------------------------------------------

// Blocks only the ranges that matter for this app's threat model:
//   - 169.254.0.0/16 (link-local / cloud metadata endpoint)
//   - 127.0.0.0/8, ::1, 0.x (loopback)
// Private RFC1918 ranges (10.x, 172.16-31.x, 192.168.x) and IPv6 ULA
// (fc00::/7) are intentionally ALLOWED — a home Jellyfin server is typically
// on the LAN, and every proxied request requires a valid session cookie, so
// unauthenticated SSRF isn't possible.
const BLOCKED_IPV4_RE = /^(169\.254\.|127\.|0\.)/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(lower)) return true;
  if (lower === os.hostname().toLowerCase()) return true;
  // IPv4 literal
  if (BLOCKED_IPV4_RE.test(lower)) return true;
  // IPv6 loopback / link-local (cloud metadata)
  if (lower.startsWith('::1') || lower.startsWith('fe80:')) {
    return true;
  }
  return false;
}

function isSelfLoop(hostname: string, port: string): boolean {
  const serverPort = process.env.PORT || '5173';
  return LOOPBACK_HOSTS.has(hostname.toLowerCase()) && port === serverPort;
}

function validateServerUrl(serverUrl: string): URL | null {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    if (isPrivateHostname(url.hostname)) {
      return null;
    }
    if (isSelfLoop(url.hostname, url.port || (url.protocol === 'https:' ? '443' : '80'))) {
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

      const data = response.data;
      const session = createSession({
        serverUrl: validatedUrl.toString().replace(/\/$/, ''),
        token: data.AccessToken,
        deviceId,
        userId: data.User.Id,
        userName: data.User.Name,
      });

      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.cookie(SESSION_COOKIE_NAME, session.id, cookieOptions(secure));

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
router.post('/auth/logout', (req: Request, res: Response) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (sessionId) {
    deleteSession(sessionId);
  }
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions(!!(req.secure || req.headers['x-forwarded-proto'] === 'https')));
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
  let currentUrl: URL = targetUrl;
  let response: AxiosResponse | null = null;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const hopResponse = await axios({
        method: req.method,
        url: currentUrl.toString(),
        responseType: 'stream',
        validateStatus: () => true,
        maxRedirects: 0,
        headers: {
          'X-Emby-Token': token,
          'X-Emby-Authorization': buildAuthHeader(deviceId),
          ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
          ...(req.headers['range'] ? { 'Range': req.headers['range'] } : {}),
        },
        data: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      });
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

  // Ensure Accept-Ranges is set for audio seeking
  if (!res.getHeader('accept-ranges')) {
    res.setHeader('Accept-Ranges', 'bytes');
  }

  // Cache images for 24 hours
  if (targetPath.includes('/Images/') && !res.getHeader('cache-control')) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }

  // Pipe the stream
  response.data.pipe(res);
});

export default router;