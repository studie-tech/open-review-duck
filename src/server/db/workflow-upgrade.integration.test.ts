import { randomUUID } from "node:crypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  backfillWorkflowMigrations,
  workflowMigrationsFolder,
} from "../../../scripts/workflow-migrations.mjs";

const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
let client: pg.Client;
let databaseName: string;
const migrations = readMigrationFiles({
  migrationsFolder: workflowMigrationsFolder,
});
const options = {
  migrationsFolder: workflowMigrationsFolder,
  migrationsTable: "workflow_migrations",
  migrationsSchema: "workflow_drizzle",
};

beforeAll(() => admin.connect());
beforeEach(async () => {
  databaseName = `workflow_upgrade_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`create database "${databaseName}"`);
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${databaseName}`;
  client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
});
afterEach(async () => {
  await client?.end();
  await admin.query(`drop database if exists "${databaseName}" with (force)`);
});
afterAll(() => admin.end());

/** Reproduces the exact migration gap shipped in Postgres World 4.3.4. */
async function installLegacyWorkflow() {
  await client.query("create schema workflow_drizzle");
  await client.query(
    "create table workflow_drizzle.workflow_migrations (id serial primary key, hash text not null, created_at bigint)",
  );
  for (const [index, migration] of migrations.entries()) {
    if (index > 10 && index !== 15) continue;
    for (const statement of migration.sql) await client.query(statement);
    await client.query(
      "insert into workflow_drizzle.workflow_migrations (hash, created_at) values ($1, $2)",
      [migration.hash, migration.folderMillis],
    );
  }
  await client.query(
    `insert into workflow.workflow_runs
      (id, deployment_id, status, name, input)
      values ('legacy-run', 'legacy-deployment', 'completed', 'legacy-workflow', '{"preserved":true}')`,
  );
}

describe("Workflow 4 appliance upgrades", () => {
  it("fills the historical gap, preserves runs, and restarts idempotently", async () => {
    await installLegacyWorkflow();
    await expect(backfillWorkflowMigrations(client)).resolves.toBe(4);
    await migrate(drizzle(client), options);
    expect(
      (
        await client.query(
          "select id, input, attributes, error_code from workflow.workflow_runs",
        )
      ).rows,
    ).toEqual([
      {
        id: "legacy-run",
        input: { preserved: true },
        attributes: {},
        error_code: null,
      },
    ]);
    expect(
      (
        await client.query(
          "select indexdef from pg_indexes where schemaname = 'workflow' and indexname = 'workflow_events_entity_creation_unique'",
        )
      ).rows[0]?.indexdef,
    ).toContain("attr_set");
    await expect(backfillWorkflowMigrations(client)).resolves.toBe(0);
    await migrate(drizzle(client), options);
    expect(
      (
        await client.query(
          "select count(*)::int as count from workflow_drizzle.workflow_migrations",
        )
      ).rows[0]?.count,
    ).toBe(migrations.length);
  });

  it("leaves new databases to the upstream migrator", async () => {
    await expect(backfillWorkflowMigrations(client)).resolves.toBe(0);
    await migrate(drizzle(client), options);
    await expect(backfillWorkflowMigrations(client)).resolves.toBe(0);
  });

  it("rolls back every backfill if an inconsistent legacy schema fails", async () => {
    await installLegacyWorkflow();
    await client.query(
      "alter table workflow.workflow_runs add column attributes jsonb",
    );
    await expect(backfillWorkflowMigrations(client)).rejects.toMatchObject({
      code: "42701",
    });
    expect(
      (
        await client.query(
          "select column_name from information_schema.columns where table_schema = 'workflow' and column_name in ('error_code', 'is_system')",
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await client.query(
          "select count(*)::int as count from workflow_drizzle.workflow_migrations",
        )
      ).rows[0]?.count,
    ).toBe(12);
  });
});
