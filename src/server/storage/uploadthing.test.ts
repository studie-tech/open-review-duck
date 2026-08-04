import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deleteFiles: vi.fn() }));

vi.mock("uploadthing/server", () => ({
  UTApi: class {
    deleteFiles = mocks.deleteFiles;
  },
  UTFile: class {},
}));

import { UploadThingSourceObjectStore } from "./uploadthing";

describe("UploadThing source storage", () => {
  it("derives stable workspace-scoped identities before uploading", () => {
    const store = new UploadThingSourceObjectStore("token", "identity-key");
    const input = {
      bytes: new Uint8Array([1]),
      digest: "a".repeat(64),
      workspaceId: "workspace-one",
    };

    expect(store.customId(input)).toBe(store.customId(input));
    expect(store.customId(input)).not.toBe(
      store.customId({ ...input, workspaceId: "workspace-two" }),
    );
  });

  it("can delete a crashed upload by its pre-persisted custom identity", async () => {
    const store = new UploadThingSourceObjectStore("token", "identity-key");

    await store.deleteByCustomId("custom-id");

    expect(mocks.deleteFiles).toHaveBeenCalledWith("custom-id", {
      keyType: "customId",
    });
  });
});
