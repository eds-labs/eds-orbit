FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fontconfig fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
# Optional content-addressed package/registry cache; empty in a normal build.
FROM runtime-base AS package-cache
RUN mkdir /seed
FROM runtime-base AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY packages/connectors/package.json ./packages/connectors/package.json
COPY packages/creative/package.json ./packages/creative/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/knowledge/package.json ./packages/knowledge/package.json
RUN --mount=type=cache,id=eds-orbit-pnpm,target=/pnpm/store,sharing=locked --mount=type=cache,id=eds-orbit-registry,target=/root/.cache/pnpm,sharing=locked --mount=type=bind,from=package-cache,source=/seed,target=/seed \
    if [ -f /seed/v11/index.db ]; then sha256sum /seed/v11/index.db > /tmp/seed-index.sha256; if ! cmp -s /tmp/seed-index.sha256 /pnpm/store/.seed-index.sha256; then cp -a /seed/v11 /pnpm/store/ && cp /tmp/seed-index.sha256 /pnpm/store/.seed-index.sha256; fi; fi && \
    if [ -d /seed/metadata ]; then cp -a /seed/metadata/. /root/.cache/pnpm/; fi && \
    pnpm install --frozen-lockfile --prefer-offline --store-dir /pnpm/store --network-concurrency=8 --fetch-timeout=600000
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json ./
COPY scripts ./scripts
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm db:generate && pnpm --dir apps/web build
FROM runtime-base AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 XDG_CACHE_HOME=/tmp/orbit-cache
WORKDIR /app
COPY --from=builder --chown=node:node /app /app
USER node
CMD ["node_modules/.bin/tsx", "apps/api/src/main.ts"]
