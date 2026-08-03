import { describe, expect, it, vi } from "vitest";

import { upgradeLegacyDatabase } from "./upgrade-legacy-database.mjs";

const baselineStatement =
  'create table "baseline_fixture" ("id" integer primary key)';
const baseline = {
  folderMillis: 1,
  hash: "baseline",
  sql: [baselineStatement],
};

/** Builds a query-aware PostgreSQL client double for legacy upgrade paths. */
function upgradeClient({
  baselineApplied = [false, false],
  columns = {},
  failBaselineWith,
  rollbackError,
  unresolvedRepositories = [],
} = {}) {
  let baselineCheck = 0;
  return {
    query: vi.fn(async (sql, params = []) => {
      if (
        sql.includes("to_regclass('public.open_review_duck_ai_configuration')")
      ) {
        return { rows: [{ journal_exists: true, legacy: true }] };
      }
      if (sql.includes("from drizzle.__drizzle_migrations")) {
        const applied = baselineApplied[baselineCheck] ?? false;
        baselineCheck += 1;
        return { rows: [{ baseline_applied: applied }] };
      }
      if (sql.includes("from information_schema.columns")) {
        const key = `${params[0]}.${params[1]}`;
        return { rows: [{ exists: columns[key] ?? true }] };
      }
      if (sql.includes('as "unresolvedCount"')) {
        return { rows: unresolvedRepositories };
      }
      if (sql === baselineStatement && failBaselineWith) {
        throw failBaselineWith;
      }
      if (sql === "rollback" && rollbackError) throw rollbackError;
      return { rows: [] };
    }),
  };
}

/** Returns the SQL text from every call made through a client double. */
function queriedStatements(client) {
  return client.query.mock.calls.map(([sql]) => sql);
}

describe("upgradeLegacyDatabase", () => {
  it("leaves a fresh database for the normal migrator", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{ journal_exists: false, legacy: false }],
      }),
    };

    await expect(upgradeLegacyDatabase(client, [baseline])).resolves.toBe(
      false,
    );
    expect(client.query).toHaveBeenCalledOnce();
  });

  it("does not reapply an already recorded compatibility baseline", async () => {
    const client = upgradeClient({ baselineApplied: [true] });

    await expect(upgradeLegacyDatabase(client, [baseline])).resolves.toBe(
      false,
    );
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it("serializes and commits the mutating upgrade path", async () => {
    const client = upgradeClient();

    await expect(upgradeLegacyDatabase(client, [baseline])).resolves.toBe(true);

    const statements = queriedStatements(client);
    expect(statements).toContain("begin");
    expect(statements).toContain("select pg_advisory_xact_lock($1)");
    expect(statements.filter((sql) => sql === baselineStatement)).toHaveLength(
      2,
    );
    expect(
      statements.some((sql) =>
        sql.includes("insert into drizzle.__drizzle_migrations"),
      ),
    ).toBe(true);
    const queueBackfill = statements.find((sql) =>
      sql.includes('insert into "open_review_duck_review_queue_item"'),
    );
    expect(queueBackfill).toContain(
      'inner join "open_review_duck_workspace_member" member',
    );
    expect(queueBackfill).toContain(
      `where pull_request."state" in ('open', 'draft')`,
    );
    expect(statements).toContain("commit");
    expect(statements).not.toContain("rollback");
  });

  it("rolls back instead of committing during a dry run", async () => {
    const client = upgradeClient();

    await expect(
      upgradeLegacyDatabase(client, [baseline], { dryRun: true }),
    ).resolves.toBe(true);

    const statements = queriedStatements(client);
    expect(statements).toContain("rollback");
    expect(statements).not.toContain("commit");
  });

  it("exits after locking when another process already completed the upgrade", async () => {
    const client = upgradeClient({ baselineApplied: [false, true] });

    await expect(upgradeLegacyDatabase(client, [baseline])).resolves.toBe(
      false,
    );

    const statements = queriedStatements(client);
    expect(statements).toContain("select pg_advisory_xact_lock($1)");
    expect(statements).toContain("rollback");
    expect(statements).not.toContain(baselineStatement);
  });

  it("rolls back a savepoint for duplicate baseline objects", async () => {
    const duplicate = Object.assign(new Error("already exists"), {
      code: "42P07",
    });
    const client = upgradeClient({ failBaselineWith: duplicate });

    await expect(upgradeLegacyDatabase(client, [baseline])).resolves.toBe(true);

    const statements = queriedStatements(client);
    expect(
      statements.filter(
        (sql) => sql === "rollback to savepoint legacy_baseline_statement",
      ),
    ).toHaveLength(2);
    expect(statements).toContain("commit");
  });

  it("rolls back and rethrows a non-skippable baseline failure", async () => {
    const failure = Object.assign(new Error("baseline failed"), {
      code: "XX000",
    });
    const client = upgradeClient({ failBaselineWith: failure });

    await expect(upgradeLegacyDatabase(client, [baseline])).rejects.toBe(
      failure,
    );
    expect(queriedStatements(client)).toContain("rollback");
  });

  it("preserves the upgrade failure when rollback also fails", async () => {
    const failure = Object.assign(new Error("baseline failed"), {
      code: "XX000",
    });
    const client = upgradeClient({
      failBaselineWith: failure,
      rollbackError: new Error("rollback failed"),
    });

    await expect(upgradeLegacyDatabase(client, [baseline])).rejects.toBe(
      failure,
    );
  });

  it("skips optional legacy columns that are absent", async () => {
    const client = upgradeClient({
      columns: {
        "open_review_duck_provider_connection.credentialFingerprint": false,
        "open_review_duck_workspace.aiMode": false,
      },
    });

    await expect(upgradeLegacyDatabase(client, [baseline])).resolves.toBe(true);

    const statements = queriedStatements(client);
    expect(
      statements.some((sql) =>
        sql.includes('alter column "credentialFingerprint"'),
      ),
    ).toBe(false);
    expect(
      statements.some((sql) =>
        sql.includes('insert into "open_review_duck_ai_preference"'),
      ),
    ).toBe(false);
  });

  it("reports repositories that cannot be assigned to a workspace", async () => {
    const client = upgradeClient({
      unresolvedRepositories: [
        {
          connectionId: null,
          id: "repo-1",
          unresolvedCount: 2,
        },
        {
          connectionId: "connection-2",
          id: "repo-2",
          unresolvedCount: 2,
        },
      ],
    });

    await expect(upgradeLegacyDatabase(client, [baseline])).rejects.toThrow(
      "2 repositories without a workspace: repo-1 (connection missing), repo-2 (connection connection-2)",
    );
    expect(queriedStatements(client)).toContain("rollback");
  });
});
