# ---- Builder Stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json package-lock.json* ./
COPY client/package.json ./client/
COPY server/package.json ./server/

# Deterministic install from lockfile
# (includes desktop devDeps like electron at build time; runner drops them)
RUN npm ci

# Copy source code (desktop-only dirs excluded via .dockerignore)
COPY client/ ./client/
COPY server/ ./server/

# Subpath base (e.g. /siren) for reverse-proxy setups. Baked into the client
# build as VITE_BASE_PATH and read at runtime as BASE_PATH — keep them in sync.
ARG BASE_PATH=/
# Build the frontend (Vite)
RUN VITE_BASE_PATH=$BASE_PATH npm run build --workspace=@siren/client

# Compile the backend TypeScript (emits server/dist/index.js)
RUN npm run build --workspace=@siren/server

# ---- Runner Stage ----
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV SIREN_DATA_DIR=/data
# Must match the BASE_PATH build arg above. Override at run time only if the
# client was built with the same value (VITE_BASE_PATH).
ARG BASE_PATH=/
ENV BASE_PATH=${BASE_PATH}
# NOTE: SIREN_TOKEN is Electron-only — never set it here. Docker relies on the
# session cookie; setting SIREN_TOKEN would 403 every browser /api call.

# Copy compiled backend
COPY --from=builder /app/server/dist ./dist

# Copy built frontend static files
COPY --from=builder /app/client/dist ./client/dist

# Copy manifests + lockfile, then install ONLY production deps
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/client/package.json ./client/package.json
RUN npm ci --omit=dev

# Create non-root user and writable data dir for file-backed sessions
RUN addgroup -S siren && adduser -S siren -G siren && mkdir -p /data && chown siren:siren /data
USER siren

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||8080;const b=(process.env.BASE_PATH||'/').replace(/\/+$/,'');fetch('http://localhost:'+p+b+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
