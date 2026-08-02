import { describe, expect, it } from "vitest";
import { applicationSecretSchema } from "./environment-secret.js";

describe("applicationSecretSchema", () => {
  it.each([
    "replace-with-at-least-32-random-characters",
    "replace-with-a-second-32-character-random-secret",
    "local-image-build-only-encryption-key",
  ])("rejects the documented placeholder %s", (value) => {
    expect(applicationSecretSchema.safeParse(value).success).toBe(false);
  });

  it("accepts a generated high-entropy value", () => {
    expect(
      applicationSecretSchema.safeParse(
        "N8B6MdxDcVmvaDfxw9HBmE6-8CTKL54dwk-tEY9PQ7D5YW49",
      ).success,
    ).toBe(true);
  });
});
