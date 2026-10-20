# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — build the TypeScript Core and the Vite SPA.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /repo
ENV npm_config_cache=/tmp/npm-cache

# Dependency manifests first (better layer caching). The Core postinstall runs
# `prisma generate`, so the schema must be present before `npm ci`.
COPY package.json package-lock.json ./
COPY core/package.json core/package.json
COPY web/package.json web/package.json
COPY core/prisma core/prisma
COPY core/prisma.config.ts core/prisma.config.ts
# The tsconfig MUST be present before `npm ci` fires `prisma generate`: without
# it the `prisma-client` generator emits `.ts` import specifiers (e.g.
# "./internal/class.ts"), which `tsc` copies verbatim into dist/ and Node cannot
# resolve at runtime. With tsconfig (module NodeNext) it emits `.js` as expected.
COPY core/tsconfig.json core/tsconfig.json
RUN npm ci --no-audit --no-fund

COPY core core
COPY web web
RUN npm run build --workspace core
RUN npm run build --workspace web

# ---------------------------------------------------------------------------
# Stage 2 — minimal production runtime (non-root), API + SPA on one origin.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/core

# The OS user keeps its legacy name so existing core-data volumes retain
# ownership across upgrades; it is internal and not a product identifier.
RUN addgroup -S statuspilot && adduser -S -G statuspilot statuspilot

COPY package.json package-lock.json /app/
COPY core/package.json /app/core/package.json
COPY web/package.json /app/web/package.json
COPY core/prisma /app/core/prisma
COPY core/prisma.config.ts /app/core/prisma.config.ts

# Production dependencies only (includes the Prisma CLI used for `migrate deploy`).
RUN cd /app \
  && npm ci --omit=dev --workspace core --include-workspace-root --no-audit --no-fund \
  && npm cache clean --force

COPY --from=build /repo/core/dist /app/core/dist
COPY --from=build /repo/web/dist /app/web

RUN mkdir -p /app/core/data && chown statuspilot:statuspilot /app/core/data
USER statuspilot

ENV HOST=0.0.0.0 \
    PORT=8080 \
    BOOTSTRAP_TOKEN_FILE=/app/core/data/bootstrap-token \
    WEB_DIST_DIR=/app/web

EXPOSE 8080
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
