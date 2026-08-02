import { setupDatabase } from "@workflow/world-postgres/cli";

/** Applies the pinned Postgres World and Graphile Worker migrations. */
async function setupWorkflow() {
  if (process.env.DEPLOYMENT_MODE === "local" && process.env.LOCAL_DATA_DIR) {
    process.chdir(process.env.LOCAL_DATA_DIR);
    process.env.DOTENV_CONFIG_QUIET = "true";
  }
  await setupDatabase();
}

await setupWorkflow();
