import { createApp } from './app';
import { loadSessions, flushSessions } from './session';

// Standalone entry point (local testing / headless runs). The packaged app
// runs server/child.ts inside an Electron utilityProcess instead.
// Default 5176 (web keeps 5173) so both stacks run side-by-side; override
// with PORT env when needed.

loadSessions();

const app = createApp();
const PORT = Number(process.env.PORT || 5176);

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[siren] Server listening on http://127.0.0.1:${PORT}`);
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
