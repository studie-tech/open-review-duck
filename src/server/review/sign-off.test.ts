import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { persistSignOffs } from "./sign-off";

type Transaction = Parameters<typeof persistSignOffs>[0];

/** Executes the real query builders against scripted database responses. */
async function signOffFixture(options: {
  authorized?: boolean;
  latest?: { id: string; hash: string; requiresReReview?: boolean };
}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const written: unknown[][] = [];
  const tx = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith("select distinct on")) {
      return {
        rows: options.latest
          ? [
              [
                options.latest.id,
                "file:unit",
                options.latest.hash,
                1,
                options.latest.requiresReReview ?? false,
                "new-snapshot",
                "pr",
              ],
            ]
          : [],
      };
    }
    if (
      sql.startsWith("select") &&
      sql.includes('"open_review_duck_workspace_member"')
    ) {
      return {
        rows:
          options.authorized === false
            ? []
            : [
                [
                  "old-unit",
                  "file:unit",
                  "reviewed-hash",
                  "pr",
                  1,
                  "old-snapshot",
                  "repo",
                  42,
                ],
              ],
      };
    }
    if (sql.startsWith("insert")) {
      // The generated insert supplies defaults for id and signedOffAt.
      written.push(params);
      return {
        rows: [
          [
            "sign-off",
            params[0],
            "user",
            params[2],
            null,
            5,
            "2026-09-14T00:00:00Z",
            null,
          ],
        ],
      };
    }
    return { rows: [] };
  });
  const outcomes = await persistSignOffs(tx as unknown as Transaction, "user", [
    { unitId: "old-unit", durationSeconds: 5 },
  ]);
  return { outcome: outcomes.get("old-unit"), queries, written };
}

describe("sign-off across revisions", () => {
  it("records the reviewed snapshot while a newer head is still preparing", async () => {
    const { outcome, queries } = await signOffFixture({});
    expect(outcome).toMatchObject({
      ok: true,
      write: {
        snapshotId: "old-snapshot",
        signOff: { unitId: "old-unit" },
      },
    });
    const publicationLock = queries.findIndex(({ sql }) =>
      sql.includes("pg_advisory_xact_lock_shared"),
    );
    const resolution = queries.findIndex(({ sql }) =>
      sql.startsWith("select distinct on"),
    );
    expect(publicationLock).toBeGreaterThan(-1);
    expect(publicationLock).toBeLessThan(resolution);
    expect(queries[publicationLock]?.params).toEqual(["repo:42"]);
    // Resolve the newest whole snapshot before looking for a surviving unit.
    expect(queries[resolution]?.sql).toMatch(/order by .*"version" desc limit/);
    expect(queries[resolution]?.sql).not.toContain('"head_sha"');
  });

  it("carries sign-off to an unchanged unit in the published snapshot", async () => {
    const { outcome } = await signOffFixture({
      latest: { id: "new-unit", hash: "reviewed-hash" },
    });
    expect(outcome).toMatchObject({
      ok: true,
      write: {
        snapshotId: "new-snapshot",
        signOff: { unitId: "new-unit" },
      },
    });
  });

  it.each([
    { id: "new-unit", hash: "changed-hash" },
    { id: "new-unit", hash: "reviewed-hash", requiresReReview: true },
  ])(
    "does not approve newer code or dependency changes: %j",
    async (latest) => {
      const { outcome, written } = await signOffFixture({ latest });
      expect(outcome).toMatchObject({
        ok: true,
        write: { signOff: { unitId: "old-unit" } },
      });
      expect(written).toHaveLength(1);
      expect(written[0]?.[0]).toBe("old-unit");
    },
  );

  it("does not write a sign-off for an inaccessible unit", async () => {
    const { outcome, written } = await signOffFixture({ authorized: false });
    expect(outcome).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(written).toEqual([]);
  });
});
