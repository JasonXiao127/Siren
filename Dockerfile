# ---- Builder Stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json package-lock.json* ./
COPY client/package.json ./client/
COPY server/package.json ./server/

# Deterministic install from lockfile
RUN npm ci

# Copy source code
COPY client/ ./client/
COPY server/ ./server/

# Build the frontend (Vite)
RUN npm run build --workspace=@siren/client

# Compile the backend TypeScript
RUN npm run build --workspace=@siren/server

# ---- Runner Stage ----
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5173

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

# Create non-root user
RUN addgroup -S siren && adduser -S siren -G siren
USER siren

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:5173/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]