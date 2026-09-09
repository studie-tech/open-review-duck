// Unit modules validate configuration at import time but must not reach a
// developer or CI database. Port 1 is deliberately unusable for PostgreSQL.
const unitDatabaseUrl =
  "postgresql://unit-test:unit-test@127.0.0.1:1/reviewduck-unit-test";

process.env.DATABASE_URL = unitDatabaseUrl;
process.env.MIGRATION_DATABASE_URL = unitDatabaseUrl;
