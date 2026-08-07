import express from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import type { IncomingMessage } from 'http';
import routes from './routes';

const app = express();
const PORT = process.env.PORT || 5173;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Trust the upstream reverse-proxy hop count when Siren runs behind a TLS
// reverse proxy (Caddy, Nginx, Traefik, ...). This makes `req.secure` report
// the client's original connection and the login rate-limiter see real client
// IPs instead of the proxy's. Set TRUST_PROXY to the number of proxy hops
// (usually 1). Leave unset (0) for a directly-exposed server.
app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Disable helmet's default `upgrade-insecure-requests`. That directive
        // makes browsers rewrite every subresource to HTTPS, which breaks a
        // plain-HTTP server reached via a LAN IP (e.g. http://192.168.x.x) —
        // the JS bundle is requested over https:// and never loads (white
        // screen). Localhost is unaffected because it's a secure context, which
        // is why this only fails on LAN/non-secure origins. This app loads only
        // same-origin resources, so it doesn't need the upgrade.
        upgradeInsecureRequests: null,
        // Media (audio) and images are streamed through our own /api/proxy
        // endpoint, so 'self' covers them. Blob/data are needed for audio
        // element edge cases in some browsers.
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
  })
);

// Redact query strings from logs — only log req.path, never query params
morgan.token('url', (req: IncomingMessage) => {
  const url = req.url || '';
  const pathname = url.split('?')[0];
  return pathname;
});
app.use(morgan(':method :url :status'));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// API routes (order matters: auth before proxy)
app.use('/api', routes);

// Production: serve static assets and SPA fallback
if (NODE_ENV === 'production') {
  // The client build lives in different places depending on the layout:
  //  - Docker runner:  compiled server at /app/dist, client at /app/client/dist
  //                    (sibling of the app root => __dirname/../client/dist)
  //  - Local monorepo: compiled server at <repo>/server/dist, client at
  //                    <repo>/client/dist (one directory ABOVE the server root
  //                    => __dirname/../../client/dist).
  // Probe each candidate and use the first one that exists so "npm start"
  // works both locally and inside the container.
  const clientDistCandidates = [
    path.join(__dirname, '../client/dist'), // Docker runner layout
    path.join(__dirname, '../../client/dist'), // local monorepo layout
    path.resolve(process.cwd(), 'client/dist'), // run from repo/client or repo root
  ];

  const clientDistPath =
    clientDistCandidates.find((candidate) => fs.existsSync(candidate)) || null;

  // Serve static assets if they exist
  if (clientDistPath && fs.existsSync(clientDistPath)) {
    console.log(`[siren] Serving client from ${clientDistPath}`);
    app.use(express.static(clientDistPath, { index: false }));

    // SPA fallback — serve index.html for client-side routing.
    // Guard against accidentally swallowing unknown /api routes.
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        return next();
      }
      res.sendFile(path.join(clientDistPath, 'index.html'));
    });
  } else {
    console.warn(`[siren] Client dist not found at ${clientDistPath}. Static serving disabled.`);
  }
}

// 404 handler for unmatched API routes
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`[siren] Server listening on port ${PORT} (${NODE_ENV})`);
});