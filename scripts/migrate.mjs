import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const MIGRATIONS_FOLDER = "./drizzle";
const MIGRATIONS_TABLE = "drizzle.__drizzle_migrations";
const APPLICATION_TABLE_PREFIX = "open_review_duck_";

const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) {
  throw new Error("MIGRATION_DATABASE_URL is required for database migrations");
}

const url = new URL(connectionString);
if (url.searchParams.get("sslrootcert") === "system") {
  url.searchParams.delete("sslrootcert");
}

/** Reads the first committed migration and the schema snapshot it represents. */
async function readBaseline() {
  const journal = JSON.parse(
    await readFile(`${MIGRATIONS_FOLDER}/meta/_journal.json`, "utf8"),
  );
  const entry = journal.entries?.find(({ idx }) => idx === 0);
  if (!entry) throw new Error("The committed migration baseline is missing");

  const sql = await readFile(`${MIGRATIONS_FOLDER}/${entry.tag}.sql`, "utf8");
  const snapshot = JSON.parse(
    await readFile(`${MIGRATIONS_FOLDER}/meta/0000_snapshot.json`, "utf8"),
  );

  return {
    createdAt: entry.when,
    hash: createHash("sha256").update(sql).digest("hex"),
    snapshot,
  };
}

/** Ensures the metadata table exists before inspecting migration history. */
async function ensureMigrationMetadata(client) {
  await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

/** Reports whether this exact squashed baseline is already recorded. */
async function isBaselineRecorded(client, baseline) {
  const result = await client.query(
    `SELECT 1 FROM ${MIGRATIONS_TABLE}
     WHERE hash = $1 AND created_at = $2
     LIMIT 1`,
    [baseline.hash, baseline.createdAt],
  );
  return result.rowCount > 0;
}

/** Counts ReviewDuck tables so fresh databases use Drizzle's normal migration. */
async function applicationTableCount(client) {
  const result = await client.query(
    `SELECT count(*)::integer AS count
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND left(table_name, $1) = $2`,
    [APPLICATION_TABLE_PREFIX.length, APPLICATION_TABLE_PREFIX],
  );
  return result.rows[0]?.count ?? 0;
}

/** Adds changes introduced after the pre-squash development baseline. */
async function upgradeLegacyBaseline(client) {
  await client.query(`
    ALTER TABLE "open_review_duck_ai_job"
      ADD COLUMN IF NOT EXISTS "reservedInputTokens" integer DEFAULT 0 NOT NULL,
      ADD COLUMN IF NOT EXISTS "reservedOutputTokens" integer DEFAULT 0 NOT NULL,
      ADD COLUMN IF NOT EXISTS "quotaSettledAt" timestamp with time zone
  `);
  await client.query(`
    ALTER TABLE "open_review_duck_ai_usage"
      ADD COLUMN IF NOT EXISTS "reservedInputTokens" integer DEFAULT 0 NOT NULL,
      ADD COLUMN IF NOT EXISTS "reservedOutputTokens" integer DEFAULT 0 NOT NULL
  `);
  await client.query(`
    ALTER TABLE "open_review_duck_repository"
      ADD COLUMN IF NOT EXISTS "sourceRetentionDays" integer DEFAULT 30 NOT NULL,
      ADD COLUMN IF NOT EXISTS "sourceRetentionSnapshots" integer DEFAULT 5 NOT NULL
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "open_review_duck_ai_dispatch" (
      "jobId" uuid PRIMARY KEY NOT NULL,
      "status" varchar(24) DEFAULT 'queued' NOT NULL,
      "attempts" integer DEFAULT 0 NOT NULL,
      "availableAt" timestamp with time zone DEFAULT now() NOT NULL,
      "leaseExpiresAt" timestamp with time zone,
      "lastError" text,
      "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
      "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "open_review_duck_rate_limit" (
      "key" varchar(255) PRIMARY KEY NOT NULL,
      "count" integer DEFAULT 0 NOT NULL,
      "expiresAt" timestamp with time zone NOT NULL
    )
  `);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint constraint_record
        JOIN pg_attribute local_column
          ON local_column.attrelid = constraint_record.conrelid
          AND local_column.attnum = ANY(constraint_record.conkey)
        JOIN pg_attribute referenced_column
          ON referenced_column.attrelid = constraint_record.confrelid
          AND referenced_column.attnum = ANY(constraint_record.confkey)
        WHERE constraint_record.contype = 'f'
          AND constraint_record.conrelid = 'public.open_review_duck_ai_dispatch'::regclass
          AND constraint_record.confrelid = 'public.open_review_duck_ai_job'::regclass
          AND local_column.attname = 'jobId'
          AND referenced_column.attname = 'id'
      ) THEN
        ALTER TABLE "open_review_duck_ai_dispatch"
          ADD CONSTRAINT "open_review_duck_ai_dispatch_jobId_open_review_duck_ai_job_id_fk"
          FOREIGN KEY ("jobId") REFERENCES "public"."open_review_duck_ai_job"("id")
          ON DELETE cascade ON UPDATE no action;
      END IF;
    END $$
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "ai_dispatch_ready_idx"
      ON "open_review_duck_ai_dispatch" USING btree ("status", "availableAt")
  `);
}

/** Validates tables, columns, enums, and indexes before adopting the baseline. */
async function validateBaseline(client, snapshot) {
  const tableResult = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  const columnResult = await client.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
  );
  const enumResult = await client.query(`
      SELECT type_record.typname AS enum_name, enum_record.enumlabel AS enum_value
      FROM pg_type type_record
      JOIN pg_enum enum_record ON enum_record.enumtypid = type_record.oid
      JOIN pg_namespace namespace_record ON namespace_record.oid = type_record.typnamespace
      WHERE namespace_record.nspname = 'public'
      ORDER BY type_record.typname, enum_record.enumsortorder
    `);
  const indexResult = await client.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
  );

  const actualTables = new Set(
    tableResult.rows.map(({ table_name }) => table_name),
  );
  const actualColumns = new Set(
    columnResult.rows.map(
      ({ table_name, column_name }) => `${table_name}.${column_name}`,
    ),
  );
  const actualEnums = new Map();
  for (const { enum_name: name, enum_value: value } of enumResult.rows) {
    actualEnums.set(name, [...(actualEnums.get(name) ?? []), value]);
  }
  const actualIndexes = new Set(
    indexResult.rows.map(({ indexname }) => indexname),
  );
  const missing = [];

  for (const table of Object.values(snapshot.tables)) {
    if (!actualTables.has(table.name)) missing.push(`table ${table.name}`);
    for (const column of Object.keys(table.columns)) {
      if (!actualColumns.has(`${table.name}.${column}`)) {
        missing.push(`column ${table.name}.${column}`);
      }
    }
    for (const index of Object.keys(table.indexes)) {
      if (!actualIndexes.has(index)) missing.push(`index ${index}`);
    }
  }
  for (const expectedEnum of Object.values(snapshot.enums)) {
    const values = actualEnums.get(expectedEnum.name) ?? [];
    if (JSON.stringify(values) !== JSON.stringify(expectedEnum.values)) {
      missing.push(`enum ${expectedEnum.name}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `The existing database does not match the ReviewDuck baseline (${missing.join(", ")}). ` +
        "Refusing to mark it as migrated; restore the expected schema or use a fresh database.",
    );
  }
}

/** Adopts a compatible pre-squash schema without recreating or deleting user data. */
async function adoptLegacyBaseline(pool, baseline) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [1_683_524_535]);
    await ensureMigrationMetadata(client);
    if (await isBaselineRecorded(client, baseline)) {
      await client.query("COMMIT");
      return false;
    }

    await upgradeLegacyBaseline(client);
    await validateBaseline(client, baseline.snapshot);
    await client.query(
      `INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE hash = $1 AND created_at = $2
       )`,
      [baseline.hash, baseline.createdAt],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Applies committed migrations, safely crossing the one-time squash boundary. */
async function runMigrations() {
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    const baseline = await readBaseline();
    const client = await pool.connect();
    let baselineRecorded;
    let tableCount;
    try {
      await ensureMigrationMetadata(client);
      baselineRecorded = await isBaselineRecorded(client, baseline);
      tableCount = await applicationTableCount(client);
    } finally {
      client.release();
    }

    if (!baselineRecorded && tableCount > 0) {
      const adopted = await adoptLegacyBaseline(pool, baseline);
      if (adopted) {
        console.log("Adopted the compatible pre-squash ReviewDuck schema.");
      }
    }

    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    console.log("Database migrations are up to date.");
  } finally {
    await pool.end();
  }
}

await runMigrations();
