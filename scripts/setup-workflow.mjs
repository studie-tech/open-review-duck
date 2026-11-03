import { setupDatabase } from "@workflow/world-postgres/cli";
import pg from "pg";
import { backfillWorkflowMigrations } from "./workflow-migrations.mjs";

/** Applies the pinned Postgres World and Graphile Worker migrations. */
async function setupWorkflow() {
  if (process.env.DEPLOYMENT_MODE === "local" && process.env.LOCAL_DATA_DIR) {
    process.chdir(process.env.LOCAL_DATA_DIR);
    process.env.DOTENV_CONFIG_QUIET = "true";
  }
  try {
    process.loadEnvFile();
  } catch (cause) {
    if (
      !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
    ) {
      throw cause;
    }
  }
  const client = new pg.Client({
    connectionString:
      process.env.WORKFLOW_POSTGRES_URL ||
      process.env.DATABASE_URL ||
      "postgres://world:world@localhost:5432/world",
    connectionTimeoutMillis: 15_000,
    query_timeout: 60_000,
  });
  await client.connect();
  try {
    const count = await backfillWorkflowMigrations(client);
    if (count) console.log(`Applied ${count} backfilled Workflow migrations.`);
  } finally {
    await client.end();
  }
  await setupDatabase();
}

await setupWorkflow();
