import type { PoolConfig } from "pg";
import { normalizeNodePostgresUrl } from "./url";

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
