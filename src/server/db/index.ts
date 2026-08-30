import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/drizzle/schema";
import { env } from "~/env";
import { nodePostgresPoolConfig, reviewPoolSize } from "./pool";

/**
 * Cache the database connection in development. This avoids creating a new connection on every HMR
 * update.
 */
const globalForDb = globalThis as unknown as {
  pool: Pool | undefined;
};

const pool =
  globalForDb.pool ??
  new Pool(
    nodePostgresPoolConfig({
      connectionString: env.DATABASE_URL,
      max: reviewPoolSize({
        configured: env.DATABASE_POOL_MAX,
        toolSlots: env.DEEP_REVIEW_TOOL_SLOTS,
        development: env.NODE_ENV !== "production",
      }),
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 15_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      queryTimeoutMillis: 20_000,
    }),
  );
if (env.NODE_ENV !== "production") globalForDb.pool = pool;

export const db = drizzle(pool, { schema });
