import type { Config } from "drizzle-kit";
import { normalizeNodePostgresUrl } from "./src/server/db/url";

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("MIGRATION_DATABASE_URL is required for Drizzle commands");
}

export default {
  schema: "./drizzle/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: normalizeNodePostgresUrl(databaseUrl),
  },
  tablesFilter: ["open_review_duck_*"],
} satisfies Config;
