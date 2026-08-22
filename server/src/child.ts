import type { Server } from 'http';
import { createApp } from './app';
import { loadSessions, flushSessions } from './session';

// Electron utilityProcess entry. Runs the Express server in a dedicated Node
// process so a crash here never takes down the window, and streaming/proxy
// work never contends with the main process event loop.
//
// Protocol with the main process (via process.parentPort):
//   child → main: { type: 'ready', port }   once the listener is bound
//   main  → child: { type: 'quit' }         graceful shutdown request
//
// Environment (set by the main process):
//   SIREN_PORT       - port to bind; 0 = ephemeral (production)
//   SIREN_DATA_DIR   - userData dir for session persistence
//   SIREN_TOKEN      - loopback auth token required on /api routes
//   SIREN_LOG_FILE   - access log destination
//   NODE_ENV         - development | production

interface ParentPort {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort: ParentPort | undefined = (process as unknown as {
  parentPort?: ParentPort;
}).parentPort;

loadSessions();

const app = createApp();
const requestedPort = Number(process.env.SIREN_PORT || 0);

const server: Server = app.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  console.log(`[siren] Server listening on http://127.0.0.1:${port}`);
  parentPort?.postMessage({ type: 'ready', port });
});

let shuttingDown = false;

function shutdown(exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  flushSessions();
  // Destroy open sockets so in-flight proxy streams can't hang shutdown.
  server.closeAllConnections?.();
  server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(1), 3000).unref();
}

parentPort?.on('message', (event) => {
  const msg = event.data as { type?: string } | null;
  if (msg?.type === 'quit') {
    shutdown(0);
  }
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => flushSessions());

// Crash guards: an uncaught exception in this process would otherwise kill
// the utility process abruptly (the main process respawns it, but we prefer
// to stay alive and keep serving). Log loudly and continue.
process.on('uncaughtException', (err) => {
  console.error('[siren] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[siren] Unhandled rejection:', reason);
});
