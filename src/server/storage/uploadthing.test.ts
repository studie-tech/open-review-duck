import { beforeEach, describe, expect, it, vi } from "vitest";

type MockUploadResult =
  | { data: { key: string }; error: null }
  | {
      data: null;
      error: { code: string; message: string; data?: unknown };
    };
type MockFileUrls = { data: Array<{ key: string; url: string }> };

const mocks = vi.hoisted(() => ({
  deleteFiles: vi.fn(),
  generateSignedURL: vi.fn(async () => ({
    ufsUrl: "https://example.test/object",
  })),
  getFileUrls: vi.fn<() => Promise<MockFileUrls>>(async () => ({ data: [] })),
  uploadFiles: vi.fn<() => Promise<MockUploadResult>>(async () => ({
    data: { key: "object-key" },
    error: null,
  })),
}));

vi.mock("uploadthing/server", () => ({
  UTApi: class {
    deleteFiles = mocks.deleteFiles;
    generateSignedURL = mocks.generateSignedURL;
    getFileUrls = mocks.getFileUrls;
    uploadFiles = mocks.uploadFiles;
  },
  UTFile: class {},
}));

import { UploadThingSourceObjectStore } from "./uploadthing";

describe("UploadThing source storage", () => {
  beforeEach(() => {
    mocks.deleteFiles.mockReset().mockResolvedValue({
      success: true,
      deletedCount: 1,
    });
    mocks.generateSignedURL.mockReset().mockResolvedValue({
      ufsUrl: "https://example.test/object",
    });
    mocks.getFileUrls.mockReset().mockResolvedValue({ data: [] });
    mocks.uploadFiles.mockReset().mockResolvedValue({
      data: { key: "object-key" },
      error: null,
    });
  });

  it("derives stable workspace- and lease-scoped identities before uploading", () => {
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
    expect(store.customId({ ...input, attemptId: "lease-one" })).not.toBe(
      store.customId({ ...input, attemptId: "lease-two" }),
    );
  });

  it("always requests private ACL for source uploads", async () => {
    const store = new UploadThingSourceObjectStore("token", "identity-key");

    await store.put({
      bytes: new Uint8Array([1]),
      digest: "a".repeat(64),
      workspaceId: "workspace-one",
    });

    expect(mocks.uploadFiles).toHaveBeenCalledWith(expect.anything(), {
      acl: "private",
      contentDisposition: "inline",
    });
  });

  it("reports absence only when the object is provably gone", async () => {
    const store = new UploadThingSourceObjectStore("token", "identity-key");
    const respond = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", respond);

    await expect(store.exists("object-key")).resolves.toBe(false);
    respond.mockResolvedValue(new Response(null, { status: 416 }));
    await expect(store.exists("object-key")).resolves.toBe(true);
    respond.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(store.exists("object-key")).rejects.toThrow("503");

    vi.unstubAllGlobals();
  });

  it("can delete a crashed upload by its pre-persisted custom identity", async () => {
    const store = new UploadThingSourceObjectStore("token", "identity-key");

    await store.deleteByCustomId("custom-id");

    expect(mocks.deleteFiles).toHaveBeenCalledWith("custom-id", {
      keyType: "customId",
    });
  });

  it("cleans a possibly committed custom ID before retrying an upload", async () => {
    mocks.uploadFiles
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "UPLOAD_FAILED",
          message: "Failed to upload file",
          data: { response: { status: 409 } },
        },
      })
      .mockResolvedValueOnce({ data: { key: "recovered-key" }, error: null });
    const store = new UploadThingSourceObjectStore("token", "identity-key");
    const input = {
      bytes: new Uint8Array([1]),
      digest: "a".repeat(64),
      workspaceId: "workspace-one",
    };

    await expect(store.put(input)).resolves.toMatchObject({
      objectKey: "recovered-key",
    });
    expect(mocks.uploadFiles).toHaveBeenCalledTimes(2);
    expect(mocks.getFileUrls).toHaveBeenCalledWith(store.customId(input), {
      keyType: "customId",
    });
    expect(mocks.deleteFiles).toHaveBeenCalledWith(store.customId(input), {
      keyType: "customId",
    });
  });

  it("adopts an upload that committed before its response was lost", async () => {
    mocks.uploadFiles.mockResolvedValueOnce({
      data: null,
      error: { code: "UPLOAD_FAILED", message: "Failed to upload file" },
    });
    mocks.getFileUrls.mockResolvedValueOnce({
      data: [{ key: "committed-key", url: "https://example.test/private" }],
    });
    const store = new UploadThingSourceObjectStore("token", "identity-key");

    await expect(
      store.put({
        attemptId: "upload-lease",
        bytes: new Uint8Array([1]),
        digest: "a".repeat(64),
        workspaceId: "workspace-one",
      }),
    ).resolves.toMatchObject({ objectKey: "committed-key" });
    expect(mocks.uploadFiles).toHaveBeenCalledOnce();
    expect(mocks.deleteFiles).not.toHaveBeenCalled();
  });

  it("retains safe provider context after bounded upload retries", async () => {
    mocks.uploadFiles.mockResolvedValue({
      data: null,
      error: {
        code: "UPLOAD_FAILED",
        message: "Failed to upload file",
        data: {
          response: {
            status: 503,
            url: "https://signed.example.test/secret",
          },
        },
      },
    });
    const store = new UploadThingSourceObjectStore("token", "identity-key");

    await expect(
      store.put({
        bytes: new Uint8Array([1]),
        digest: "a".repeat(64),
        workspaceId: "workspace-one",
      }),
    ).rejects.toThrow(
      "UploadThing source upload failed: Failed to upload file (UPLOAD_FAILED, HTTP 503)",
    );
    expect(mocks.uploadFiles).toHaveBeenCalledTimes(3);
    expect(mocks.deleteFiles).toHaveBeenCalledTimes(3);
  });

  it("redacts signed URLs embedded in provider error messages", async () => {
    mocks.uploadFiles.mockResolvedValue({
      data: null,
      error: {
        code: "UPLOAD_FAILED",
        message:
          "Upload failed at https://signed.example.test/object?token=secret",
      },
    });
    const store = new UploadThingSourceObjectStore("token", "identity-key");

    const failure = await store
      .put({
        bytes: new Uint8Array([1]),
        digest: "a".repeat(64),
        workspaceId: "workspace-one",
      })
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("[redacted URL]");
    expect((failure as Error).message).not.toContain("signed.example.test");
    expect((failure as Error).message).not.toContain("token=secret");
  });
});
