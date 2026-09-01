import { describe, expect, it, vi } from "vitest";
import { SELECT_IDS_CHUNK_SIZE, selectByIdsInChunks } from "./select-in-chunks";

describe("selectByIdsInChunks", () => {
  it("loads and combines identifier lists larger than one query chunk", async () => {
    const ids = Array.from(
      { length: SELECT_IDS_CHUNK_SIZE + 1 },
      (_value, index) => `unit-${index}`,
    );
    const select = vi.fn(async (chunk: string[]) =>
      chunk.map((id) => ({ id })),
    );

    const rows = await selectByIdsInChunks(ids, select);

    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls.map(([chunk]) => chunk.length)).toEqual([
      SELECT_IDS_CHUNK_SIZE,
      1,
    ]);
    expect(rows).toEqual(ids.map((id) => ({ id })));
  });

  it("does not issue a select for an empty identifier list", async () => {
    const select = vi.fn(async (_chunk: string[]) => []);

    await expect(selectByIdsInChunks([], select)).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});
