import { beforeEach, describe, expect, it, vi } from "vitest";
import type { db } from "~/server/db";
import {
  uploadCommentImage,
  uploadCommentImageSchema,
} from "./upload-comment-image";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  rate: vi.fn(),
  writer: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("~/server/review/provider-thread", () => ({
  providerScopeForUnit: mocks.scope,
  providerThreadError: (_: unknown, error: unknown) => error,
}));
vi.mock("~/server/providers/user-credentials", () => ({
  providerForReviewerWrite: mocks.writer,
}));
vi.mock("~/server/security/rate-limit", () => ({
  enforceRateLimit: mocks.rate,
}));
const database = {} as typeof db;
const input = {
  unitId: "00000000-0000-4000-8000-000000000001",
  contentType: "image/png" as const,
  base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64"),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({
    connection: {},
    repositoryExternalId: "repo",
    pullRequestNumber: 12,
  });
  mocks.writer.mockResolvedValue({
    provider: { name: "azure_devops", uploadCommentImage: mocks.upload },
  });
  mocks.upload.mockResolvedValue("https://dev.azure.com/image.png");
});
describe("authorized comment image uploads", () => {
  it("uses the authorized provider scope and reviewer credentials", async () => {
    expect(await uploadCommentImage(database, "user", input)).toEqual({
      markdown: "![Image](<https://dev.azure.com/image.png>)",
    });
    expect(mocks.writer).toHaveBeenCalledWith(database, {}, "user");
    expect(mocks.upload).toHaveBeenCalledWith({
      repositoryExternalId: "repo",
      pullRequestNumber: 12,
      file: expect.any(File),
    });
    expect(mocks.rate).toHaveBeenCalled();
  });
  it("never uploads without workspace access", async () => {
    mocks.scope.mockRejectedValueOnce(new Error("Forbidden"));
    await expect(uploadCommentImage(database, "user", input)).rejects.toThrow(
      "Forbidden",
    );
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("rejects disguised content before contacting the provider", async () => {
    await expect(
      uploadCommentImage(database, "user", {
        ...input,
        base64: Buffer.from("<script>alert(1)</script>").toString("base64"),
      }),
    ).rejects.toThrow("Paste a PNG");
    expect(mocks.writer).not.toHaveBeenCalled();
  });
  it("bounds encoded requests and rejects malformed base64", () => {
    expect(
      uploadCommentImageSchema.safeParse({
        ...input,
        base64: "a".repeat(3_000_000),
      }).success,
    ).toBe(false);
    expect(
      uploadCommentImageSchema.safeParse({ ...input, base64: "%%%%" }).success,
    ).toBe(false);
  });
  it("does not insert an unsafe provider URL", async () => {
    mocks.upload.mockResolvedValueOnce("javascript:alert(1)");
    await expect(uploadCommentImage(database, "user", input)).rejects.toThrow(
      "Invalid attachment URL",
    );
  });
});
