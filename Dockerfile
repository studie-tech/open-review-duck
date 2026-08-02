# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS node-base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app

FROM node-base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
ENV DEPLOYMENT_MODE=local
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=postgresql://reviewduck:build-only@localhost/reviewduck
RUN pnpm build

FROM dependencies AS workflow-runtime
COPY docker/workflow-runtime/package.json ./docker/workflow-runtime/package.json
RUN pnpm --filter @reviewduck/workflow-runtime deploy --prod /workflow-runtime

FROM postgres:18-bookworm AS runtime
ARG REVIEWDUCK_VERSION=development
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production
ENV DEPLOYMENT_MODE=local
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV LOCAL_DATA_DIR=/data
ENV WORKFLOW_TARGET_WORLD=@workflow/world-postgres
ENV WORKFLOW_POSTGRES_JOB_PREFIX=reviewduck
ENV WORKFLOW_POSTGRES_WORKER_CONCURRENCY=2
ENV WORKFLOW_POSTGRES_MAX_POOL_SIZE=4
ENV ALLOW_PRIVATE_AI_HOSTS=true
ENV ALLOW_PRIVATE_PROVIDER_HOSTS=true
ENV REVIEWDUCK_VERSION=$REVIEWDUCK_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git libatomic1 tini util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/local/bin/gosu \
    && useradd --uid 10001 --user-group --create-home --shell /usr/sbin/nologin reviewduck \
    && install -d -m 0755 -o reviewduck -g reviewduck /app /data

WORKDIR /app
COPY --from=build --chown=reviewduck:reviewduck /app/.next/standalone ./
COPY --from=workflow-runtime --chown=reviewduck:reviewduck /workflow-runtime/node_modules ./node_modules
COPY --from=build --chown=reviewduck:reviewduck /app/.next/static ./.next/static
COPY --from=build --chown=reviewduck:reviewduck /app/public ./public
COPY --from=build --chown=reviewduck:reviewduck /app/drizzle ./drizzle
COPY --from=build --chown=reviewduck:reviewduck /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=build --chown=reviewduck:reviewduck /app/scripts/latest-migration-hash.mjs ./scripts/latest-migration-hash.mjs
COPY --from=build --chown=reviewduck:reviewduck /app/scripts/setup-workflow.mjs ./scripts/setup-workflow.mjs
COPY --from=build --chown=reviewduck:reviewduck /app/scripts/local-bootstrap.mjs ./scripts/local-bootstrap.mjs
COPY --from=build --chown=reviewduck:reviewduck /app/scripts/local-bootstrap-output.mjs ./scripts/local-bootstrap-output.mjs
COPY --from=build --chown=reviewduck:reviewduck /app/scripts/local-admin.mjs ./scripts/local-admin.mjs
COPY --chown=root:root docker/local-entrypoint.sh /usr/local/bin/reviewduck-local

RUN find /app/node_modules/.pnpm -maxdepth 1 -type d \
      \( -name '@esbuild+*' -o -name '@typescript+typescript-*' \) \
      -exec rm -rf {} + \
    && chmod 0755 /usr/local/bin/reviewduck-local

VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD curl --fail --silent http://127.0.0.1:3000/api/health >/dev/null || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/reviewduck-local"]
