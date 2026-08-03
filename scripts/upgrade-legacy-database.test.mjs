import { describe, expect, it, vi } from "vitest";

import { upgradeLegacyDatabase } from "./upgrade-legacy-database.mjs";

const baseline = { folderMillis: 1, hash: "baseline", sql: [] };

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
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ journal_exists: true, legacy: true }],
        })
        .mockResolvedValueOnce({ rows: [{ baseline_applied: true }] }),
    };

    await expect(upgradeLegacyDatabase(client, [baseline])).resolves.toBe(
      false,
    );
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});
