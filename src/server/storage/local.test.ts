import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalSourceObjectStore } from "./local";

describe("LocalSourceObjectStore", () => {
  it("writes immutable workspace-scoped objects and reads them back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reviewduck-objects-"));
    const store = new LocalSourceObjectStore(root);
    const digest = "a".repeat(64);
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const input = {
      bytes: new TextEncoder().encode("select 1"),
      digest,
      workspaceId,
    };
    const stored = await store.put(input);
    expect(stored.objectKey).toBe(store.customId(input));
    expect(await store.exists(stored.objectKey)).toBe(true);
    expect(new TextDecoder().decode(await store.read(stored.objectKey))).toBe(
      "select 1",
    );
    expect(await readFile(path.join(root, stored.objectKey), "utf8")).toBe(
      "select 1",
    );
    await store.deleteByCustomId(store.customId(input));
    expect(await store.exists(stored.objectKey)).toBe(false);
    await expect(store.read(stored.objectKey)).rejects.toThrow();
  });

  it("rejects traversal identities", async () => {
    const store = new LocalSourceObjectStore("/tmp/reviewduck-test");
    await expect(
      store.put({
        bytes: new Uint8Array(),
        digest: "a".repeat(64),
        workspaceId: "../escape",
      }),
    ).rejects.toThrow("Invalid");
  });

  it("rejects traversal keys through crashed-write cleanup", async () => {
    const store = new LocalSourceObjectStore("/tmp/reviewduck-test");
    await expect(store.deleteByCustomId("../escape")).rejects.toThrow(
      "escapes the storage root",
    );
  });

  it("refuses to report a rejected key as an absent object", async () => {
    const store = new LocalSourceObjectStore("/tmp/reviewduck-test");
    await expect(store.exists("../escape")).rejects.toThrow(
      "escapes the storage root",
    );
  });
});
