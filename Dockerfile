# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.14.0 --activate
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
ENV DEPLOYMENT_MODE=local
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=postgresql://reviewduck:reviewduck@127.0.0.1:5432/reviewduck
ENV ENCRYPTION_KEY=local-image-build-only-encryption-key
ENV FLUE_BASE_URL=http://127.0.0.1:3100
ENV FLUE_DATABASE_URL=postgresql://reviewduck:reviewduck@127.0.0.1:5432/reviewduck
ENV FLUE_INTERNAL_SECRET=local-image-build-only-internal-secret
RUN pnpm build:agent && pnpm build

FROM base AS production-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-prod,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV DEPLOYMENT_MODE=local
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3666
ENV AGENT_PORT=3100
ENV DATA_DIR=/data
ENV DATABASE_URL=postgresql://postgres@127.0.0.1:5432/reviewduck
ENV MIGRATION_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/reviewduck
ENV FLUE_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/reviewduck
ENV FLUE_BASE_URL=http://127.0.0.1:3100
ENV FLUE_CONTROL_PLANE_URL=http://127.0.0.1:3666
ENV ALLOW_PRIVATE_AI_HOSTS=true
ENV ALLOW_PRIVATE_PROVIDER_HOSTS=false
ENV MANAGED_AI_MODEL=gpt-5-mini

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl postgresql postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/ssl/private/ssl-cert-snakeoil.key \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin reviewduck \
    && mkdir -p /app /data \
    && chown reviewduck:reviewduck /app

WORKDIR /app
COPY --from=production-dependencies --chown=reviewduck:reviewduck /app/node_modules ./node_modules
COPY --from=build --chown=reviewduck:reviewduck /app/.next ./.next
COPY --from=build --chown=reviewduck:reviewduck /app/dist/flue ./dist/flue
COPY --from=build --chown=reviewduck:reviewduck /app/public ./public
COPY --from=build --chown=reviewduck:reviewduck /app/src ./src
COPY --from=build --chown=reviewduck:reviewduck /app/drizzle ./drizzle
COPY --from=build --chown=reviewduck:reviewduck /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build --chown=reviewduck:reviewduck /app/next.config.js ./next.config.js
COPY --from=build --chown=reviewduck:reviewduck /app/package.json ./package.json
COPY --from=build --chown=reviewduck:reviewduck /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --chown=root:root docker/local-entrypoint.sh /usr/local/bin/reviewduck-local

RUN find /app/node_modules/.pnpm -path '*/@typescript/typescript-*/lib/tsc' -type f -delete \
    && chmod 0755 /usr/local/bin/reviewduck-local

VOLUME ["/data"]
EXPOSE 3666
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=5 \
  CMD curl --fail --silent http://127.0.0.1:3666/dashboard >/dev/null || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["reviewduck-local"]
