// Unit modules validate configuration at import time but must not reach a
// developer database. Port 1 is deliberately unusable for PostgreSQL.
const testDatabaseUrl =
  "postgresql://unit-test:unit-test@127.0.0.1:1/reviewduck-unit-test";

process.env.DATABASE_URL ??= testDatabaseUrl;
process.env.MIGRATION_DATABASE_URL ??= testDatabaseUrl;
process.env.DEPLOYMENT_MODE ??= "local";
process.env.NEXT_PUBLIC_DEPLOYMENT_MODE ??= "local";
process.env.ENCRYPTION_KEY ??=
  "unit-test-encryption-key-with-at-least-32-characters";
process.env.CRON_SECRET ??= "unit-test-cron-secret-with-at-least-32-characters";
process.env.STORAGE_ID_KEY ??=
  "unit-test-storage-key-with-at-least-32-characters";
