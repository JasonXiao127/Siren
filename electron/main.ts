import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  net,
  protocol,
  shell,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Siren desktop shell.
//
// Architecture:
//   - The Express server runs in a dedicated utilityProcess (crash isolation,
//     no main-thread contention) bound to 127.0.0.1 on an ephemeral port.
//   - The renderer loads the stable origin app://siren (registered below as
//     standard+secure). Every request is forwarded to the loopback server via
//     Node fetch with a per-launch token header that the server requires.
//   - A stable origin matters because localStorage is origin-scoped INCLUDING
//     the port — an ephemeral http://127.0.0.1:<port> origin would wipe the
//     user's settings, deviceId, and login state every launch. Cookies are
//     host-scoped only, so they'd survive — silently half-breaking the app.
//
// Dev mode (VITE_DEV_SERVER_URL set by scripts/dev.mjs):
//   - The server child binds fixed port 5173 (matches Vite's /api proxy).
//   - The window loads the Vite dev server directly so HMR works.
//
// CRITICAL: responses delivered through the app:// handler must never carry
// Origin-Agent-Cluster (helmet sets it by default; disabled in server/app.ts,
// and stripped defensively below). On a non-standard scheme it crashes the
// browser process when the renderer dispatches its next request.
// ---------------------------------------------------------------------------

const APP_SCHEME = 'app';
const APP_ORIGIN = 'app://siren';
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || '';
const IS_DEV = !!DEV_SERVER_URL;

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let serverProcess: UtilityProcess | null = null;
let serverPort: number | null = null;
let serverToken = '';
let quitting = false;

// Crash respawn backoff: doubles per consecutive failure, resets after 60s
// of healthy uptime. Bounded — after MAX_RESPAWN_ATTEMPTS we surface an
// error dialog instead of looping forever.
const MAX_RESPAWN_ATTEMPTS = 5;
let respawnAttempts = 0;
let healthySince = 0;
let respawnScheduled = false;

function scheduleRespawn(): void {
  if (quitting || respawnScheduled) return;

  if (respawnAttempts >= MAX_RESPAWN_ATTEMPTS) {
    console.error('[siren] Server failed to stay up — giving up.');
    dialog.showErrorBox(
      'Siren',
      'The Siren backend failed to start after several attempts.\nPlease restart the app.'
    );
    app.exit(1);
    return;
  }

  respawnScheduled = true;
  respawnAttempts += 1;
  const delay = Math.min(1000 * 2 ** Math.min(respawnAttempts - 1, 4), 16000);
  console.error(
    `[siren] Respawning server (attempt ${respawnAttempts}/${MAX_RESPAWN_ATTEMPTS}) in ${delay}ms`
  );
  setTimeout(() => {
    respawnScheduled = false;
    if (!quitting) {
      startServerChild().catch((err) => {
        // Timed out waiting for ready — the stuck child was killed and its
        // exit handler will schedule the next attempt.
        console.error(err.message);
      });
    }
  }, delay);
}

function startServerChild(): Promise<number> {
  return new Promise((resolve, reject) => {
    serverToken = crypto.randomBytes(24).toString('hex');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: IS_DEV ? 'development' : 'production',
      SIREN_DATA_DIR: app.getPath('userData'),
      SIREN_LOG_FILE: path.join(app.getPath('userData'), 'logs', 'siren.log'),
      // Dev skips the loopback token: the renderer talks to the server via
      // Vite's /api proxy, which can't know the per-launch token. Loopback
      // bind alone is acceptable protection for a dev session.
      ...(!IS_DEV ? { SIREN_TOKEN: serverToken } : {}),
      ...(IS_DEV ? { SIREN_PORT: '5173' } : {}),
    };

    const timer = setTimeout(() => {
      reject(new Error('[siren] Server process failed to report ready within 10s'));
      // Kill the stuck child; its exit handler schedules the next attempt.
      try {
        serverProcess?.kill();
      } catch {
        // already gone
      }
    }, 10000);

    serverProcess = utilityProcess.fork(path.join(__dirname, 'server.cjs'), [], {
      env,
      serviceName: 'siren-server',
    });

    serverProcess.on('message', (msg: { type?: string; port?: number }) => {
      if (msg?.type === 'ready' && typeof msg.port === 'number') {
        clearTimeout(timer);
        serverPort = msg.port;
        healthySince = Date.now();
        respawnAttempts = 0;
        resolve(msg.port);
      }
    });

    serverProcess.on('exit', (code) => {
      clearTimeout(timer);
      const wasHealthy = healthySince > 0 && Date.now() - healthySince > 60_000;
      serverPort = null;
      serverProcess = null;

      if (quitting) return;

      // Unexpected death — respawn with backoff so a transient crash
      // doesn't take the whole app down.
      if (wasHealthy) respawnAttempts = 0;
      console.error(`[siren] Server exited unexpectedly (code ${code})`);
      scheduleRespawn();
    });
  });
}

/**
 * Forwards an app:// request to the loopback server. Fully defensive: any
 * failure (including a malformed request URL) becomes a 502 rather than a
 * rejected protocol handler.
 *
 * Request headers are whitelisted: renderer headers like Origin: app://siren,
 * Referer, and sec-fetch-* describe the custom-scheme context and must not
 * leak into plain-http upstream requests.
 *
 * Response headers are sanitized: hop-by-hop headers and stale
 * content-length/content-encoding break the renderer's URLLoader, and
 * Origin-Agent-Cluster crashes it outright on non-standard schemes (see file
 * comment).
 */
async function forwardToServer(request: Request): Promise<Response> {
  try {
    return await doForward(request);
  } catch (err) {
    console.error('[siren] Forward failed:', err);
    return new Response(JSON.stringify({ error: 'Siren server unreachable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function doForward(request: Request): Promise<Response> {
  if (serverPort === null) {
    return new Response(JSON.stringify({ error: 'Siren server is restarting' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const headers = new Headers();
  const FORWARD_REQUEST_HEADERS = [
    'accept',
    'accept-language',
    'content-type',
    'range',
    'user-agent',
  ];
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('X-Siren-Token', serverToken);

  const target = `http://127.0.0.1:${serverPort}${url.pathname}${url.search}`;
  // `duplex` is required by undici-style fetch when streaming a request body;
  // it isn't in TS's RequestInit yet.
  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
    ...(request.method !== 'GET' && request.method !== 'HEAD'
      ? { body: request.body, duplex: 'half' }
      : {}),
  } as unknown as RequestInit;

  // The upstream leg MUST use net.fetch (Chromium's network stack), not
  // Node's undici fetch: an undici Response passed through the protocol
  // boundary does not deliver Set-Cookie to the session cookie jar, which
  // silently broke login (server set the cookie; renderer never stored it).
  // net.fetch Responses are native to this boundary — verified end-to-end.
  const upstream = await net.fetch(target, init);

  const STRIP_RESPONSE_HEADERS = new Set([
    'connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'content-encoding',
    'content-length',
    'origin-agent-cluster',
    // Copied explicitly below via getSetCookie() — forEach/set would collapse
    // multiple cookies into one value.
    'set-cookie',
  ]);
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append('set-cookie', cookie);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/** Compares protocol + host (hostname:port) — custom schemes have opaque
 * WHATWG origins, so URL.origin comparison would wrongly return 'null'. */
function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

function registerNavigationGuards(win: BrowserWindow): void {
  const allowedOrigin = IS_DEV ? DEV_SERVER_URL : APP_ORIGIN;

  // window.location = <external> navigates the app window away — intercept
  // and open externally instead. Same-origin navigation (e.g. the 401
  // interceptor's redirect to /login) passes through untouched. Compare
  // parsed hosts, NOT string prefixes (a startsWith check would admit
  // http://localhost:5174.evil.com).
  win.webContents.on('will-navigate', (event, url) => {
    if (sameOrigin(url, allowedOrigin)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

/** F12 / Ctrl+Shift+I toggle DevTools. The application menu is removed
 * everywhere, which also removes its accelerator table, so dev builds need
 * this explicit handler. */
function registerDevtoolsShortcut(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isCtrlShiftI = input.control && input.shift && input.key.toLowerCase() === 'i';
    if (isF12 || isCtrlShiftI) {
      win.webContents.toggleDevTools();
    }
  });
}

function createWindow(): void {
  // The app's own TopBar is the window header — no native menu, no native
  // title bar (titleBarStyle below).
  Menu.setApplicationMenu(null);

  const isMac = process.platform === 'darwin';

  // Dev runs get the Siren taskbar/window icon from buildResources. Packaged
  // builds embed the icon in the executable automatically, so no path needed.
  const devIconPath = path.join(__dirname, '..', 'packaging', 'icon.png');

  // Hidden title bar: the renderer's TopBar becomes the window header. On
  // Windows/Linux the native min/max/close buttons are drawn by the OS as an
  // overlay themed to the app; macOS uses floating traffic lights.
  const titleBarOptions = isMac
    ? { titleBarStyle: 'hiddenInset' as const }
    : {
        titleBarStyle: 'hidden' as const,
        titleBarOverlay: {
          color: '#121212',
          symbolColor: '#e4e4e7',
          height: 36,
        },
      };

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#121212',
    title: 'Siren',
    show: false,
    ...(fs.existsSync(devIconPath) ? { icon: devIconPath } : {}),
    ...titleBarOptions,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (IS_DEV) {
    registerDevtoolsShortcut(mainWindow);
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  registerNavigationGuards(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const target = IS_DEV ? DEV_SERVER_URL : `${APP_ORIGIN}/`;
  loadWithRetry(mainWindow, target);
}

/** An unhandled loadURL rejection would crash the main process (Node's
 * default unhandled-rejection behavior), so failures are caught: one retry,
 * then a visible error instead of a silent death. */
async function loadWithRetry(win: BrowserWindow, url: string): Promise<void> {
  try {
    await win.loadURL(url);
    return;
  } catch {
    // First attempt failed (e.g. backend still settling) — retry once.
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (!win.isDestroyed()) {
    try {
      await win.loadURL(url);
    } catch (err) {
      dialog.showErrorBox('Siren', `Failed to load the app UI:\n${String(err)}`);
    }
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await startServerChild();
    } catch (err) {
      // Initial boot failed. Mark quitting so the exit handler doesn't
      // schedule a respawn race, tell the user, and bail out cleanly.
      quitting = true;
      console.error(err);
      dialog.showErrorBox(
        'Siren',
        'The Siren backend failed to start.\nPlease restart the app.'
      );
      app.exit(1);
      return;
    }
    protocol.handle(APP_SCHEME, forwardToServer);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // Graceful shutdown: give the server child time to flush sessions and
  // close cleanly before we exit. Force-exits after 3s in case it hangs.
  app.on('before-quit', (event) => {
    if (quitting || !serverProcess) return;
    quitting = true;
    event.preventDefault();
    serverProcess.postMessage({ type: 'quit' });
    const forceExit = setTimeout(() => app.exit(0), 3000);
    serverProcess.once('exit', () => {
      clearTimeout(forceExit);
      app.quit();
    });
  });
}
