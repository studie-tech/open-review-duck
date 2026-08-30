import type { PoolConfig } from "pg";
import { normalizeNodePostgresUrl } from "./url";

/**
 * Connections a runtime process needs beside a file scout's tool calls: the
 * status polling, the maintenance cron, and the page queries that must not
 * queue behind a review.
 */
const REVIEW_POOL_HEADROOM = 4;

interface ReviewPoolOptions {
  /** `DATABASE_POOL_MAX`, which raises the floor and never lowers it. */
  configured: number;
  /** `DEEP_REVIEW_TOOL_SLOTS`: tool bodies one file scout runs at once. */
  toolSlots: number;
  development: boolean;
}

/**
 * Sizes the runtime pool to the statement wave a single file scout holds.
 *
 * Deriving the floor from `toolSlots` keeps the two knobs from drifting into a
 * pool too small for the fan-out it exists to cover: a scout runs that many
 * tool bodies at once, each writing on the pooled handle. Deployments that
 * drain whole lanes inside one process raise `DATABASE_POOL_MAX` above the
 * floor; the ceiling stays theirs to choose because every concurrent
 * serverless instance carries its own pool against one shared
 * `max_connections`. Development runs the floor alone, so a fan-out can be
 * exercised locally without a production ceiling.
 */
export function reviewPoolSize({
  configured,
  toolSlots,
  development,
}: ReviewPoolOptions): number {
  const floor = toolSlots + REVIEW_POOL_HEADROOM;
  return development ? floor : Math.max(configured, floor);
}

interface NodePostgresPoolOptions {
  connectionString: string;
  connectionTimeoutMillis: number;
  idleTimeoutMillis?: number;
  keepAlive?: boolean;
  keepAliveInitialDelayMillis?: number;
  max: number;
  queryTimeoutMillis: number;
}

/**
 * Builds a PgBouncer-compatible node-postgres pool configuration.
 *
 * Server-side session parameters such as `statement_timeout` must not be sent
 * in the startup packet: pooled PlanetScale endpoints reject them. The
 * node-postgres `query_timeout` remains client-side and applies to every query
 * issued through the pool without leaking session state between pooled users.
 */
export function nodePostgresPoolConfig({
  connectionString,
  connectionTimeoutMillis,
  idleTimeoutMillis,
  keepAlive,
  keepAliveInitialDelayMillis,
  max,
  queryTimeoutMillis,
}: NodePostgresPoolOptions): PoolConfig {
  return {
    connectionString: normalizeNodePostgresUrl(connectionString),
    connectionTimeoutMillis,
    idleTimeoutMillis,
    keepAlive,
    keepAliveInitialDelayMillis,
    max,
    query_timeout: queryTimeoutMillis,
  };
}
