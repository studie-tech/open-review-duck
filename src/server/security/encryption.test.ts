import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, fingerprintSecret } from "./encryption";

describe("credential encryption", () => {
  const key = "a-test-encryption-key-that-is-long-enough";

  it("round trips without exposing plaintext", () => {
    const encrypted = encryptSecret("provider-token", key);
    expect(encrypted).not.toContain("provider-token");
    expect(decryptSecret(encrypted, key)).toBe("provider-token");
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptSecret("provider-token", key);
    expect(() => decryptSecret(`${encrypted}x`, key)).toThrow();
  });

  it("creates stable, non-reversible credential fingerprints", () => {
    const first = fingerprintSecret("provider-token", key);
    const second = fingerprintSecret("provider-token", key);

    expect(first).toBe(second);
    expect(first).toHaveLength(64);
    expect(first).not.toContain("provider-token");
    expect(fingerprintSecret("another-token", key)).not.toBe(first);
  });
});
