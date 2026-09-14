import { createApp } from './app';
import { loadSessions, flushSessions } from './session';

// Standalone entry point (local testing / Docker / headless runs). The
// packaged app runs server/child.ts inside an Electron utilityProcess instead.
// Default 5176; override with PORT env when needed. Docker sets PORT=8080.
// NOTE: Docker/standalone intentionally runs WITHOUT SIREN_TOKEN (see
// server/src/app.ts). Auth relies on the httpOnly session cookie; do not set
// SIREN_TOKEN in Docker — browsers have no way to send it and all /api calls
// would 403.

loadSessions();

const app = createApp();
const PORT = Number(process.env.PORT || 5176);
// In Docker/prod the server must bind 0.0.0.0 so the mapped port is
// reachable from the host. Locally keep loopback-only. HOST overrides.
const HOST =
  process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

const server = app.listen(PORT, HOST, () => {
  console.log(`[siren] Server listening on http://${HOST}:${PORT}`);
});

function shutdown(): void {
  flushSessions();
  // Destroy open sockets so in-flight proxy streams can't hang shutdown.
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => flushSessions());
