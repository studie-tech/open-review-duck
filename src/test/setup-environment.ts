import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Database URLs are suite-specific: unit tests force an unusable port-1 URL,
// and integration tests require a real isolated PostgreSQL 18 database.
process.env.DEPLOYMENT_MODE ??= "local";
process.env.NEXT_PUBLIC_DEPLOYMENT_MODE ??= "local";
process.env.ENCRYPTION_KEY ??=
  "unit-test-encryption-key-with-at-least-32-characters";
process.env.CRON_SECRET ??= "unit-test-cron-secret-with-at-least-32-characters";
process.env.STORAGE_ID_KEY ??=
  "unit-test-storage-key-with-at-least-32-characters";
process.env.LOCAL_DATA_DIR ??= mkdtempSync(
  path.join(tmpdir(), "reviewduck-test-data-"),
);
process.env.OPENROUTER_MANAGEMENT_KEY ??=
  "integration-openrouter-management-key";
