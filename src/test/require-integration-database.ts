const unitDatabaseHost = "127.0.0.1:1";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error(
    "pnpm test:integration requires DATABASE_URL to point at an isolated PostgreSQL 18 database.",
  );
}
if (databaseUrl.includes(unitDatabaseHost)) {
  throw new Error(
    "pnpm test:integration cannot use the unit-test DATABASE_URL. Point it at a real PostgreSQL 18 database.",
  );
}
