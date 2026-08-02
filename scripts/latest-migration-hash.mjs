import { readMigrationFiles } from "drizzle-orm/migrator";

const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
const latest = migrations.at(-1);
if (!latest) throw new Error("No committed Drizzle migrations were found");
process.stdout.write(latest.hash);
