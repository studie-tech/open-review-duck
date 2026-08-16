import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(async () => undefined),
  verify: vi.fn(async () => true),
}));

vi.mock("server-only", () => ({}));
vi.mock("@node-rs/argon2", () => ({ verify: mocks.verify }));
vi.mock("~/server/security/rate-limit", () => ({
  enforceRateLimit: mocks.enforceRateLimit,
}));

import {
  authorizeSemanticUploadCredential,
  newSemanticUploadCredential,
} from "./upload-credentials";

/** Builds the query chain used to resolve one upload credential. */
function database(credentials: Array<Record<string, unknown>> = []) {
  const limit = vi.fn(async () => credentials);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));
  return {
    db: {
      query: {
        repositories: {
          findFirst: vi.fn(async () => ({ id: "repository" })),
        },
      },
      select,
    },
    select,
  };
}

describe("semantic upload credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockResolvedValue(true);
  });

  it("creates lookup-addressable credentials", () => {
    const credential = newSemanticUploadCredential();

    expect(credential.token).toMatch(new RegExp(`^${credential.id}\\.`));
  });

  it("rejects opaque tokens without scanning repository credentials", async () => {
    const { db, select } = database();

    await expect(
      authorizeSemanticUploadCredential(
        db as never,
        "repository",
        "a".repeat(64),
      ),
    ).resolves.toBeUndefined();

    expect(select).not.toHaveBeenCalled();
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("verifies only the credential named by the token", async () => {
    const generated = newSemanticUploadCredential();
    const credential = {
      id: generated.id,
      revokedAt: null,
      tokenHash: "argon-hash",
      workspaceId: "workspace",
    };
    const { db } = database([credential]);

    await expect(
      authorizeSemanticUploadCredential(
        db as never,
        "repository",
        generated.token,
      ),
    ).resolves.toBe(credential);

    expect(mocks.enforceRateLimit).toHaveBeenCalledWith(
      db,
      "scip-upload:repository",
      30,
      60_000,
    );
    expect(mocks.verify).toHaveBeenCalledWith("argon-hash", generated.token);
  });
});
