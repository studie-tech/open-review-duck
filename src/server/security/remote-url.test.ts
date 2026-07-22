import { describe, expect, it } from "vitest";
import { assertSafeRemoteUrl, isPrivateAddress } from "./remote-url";

describe("provider URL security", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "100.64.0.1",
    "172.16.4.2",
    "192.168.1.10",
    "192.0.2.1",
    "198.51.100.4",
    "203.0.113.8",
    "224.0.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.1.2",
    "::ffff:172.16.4.2",
    "::ffff:192.168.1.10",
  ])("recognizes private address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it("rejects private provider hosts by default", async () => {
    await expect(
      assertSafeRemoteUrl("http://127.0.0.1:8080/api", false),
    ).rejects.toThrow("HTTPS");
    await expect(
      assertSafeRemoteUrl("https://127.0.0.1/api", false),
    ).rejects.toThrow("Private provider hosts");
  });

  it("allows explicitly configured private providers", async () => {
    await expect(
      assertSafeRemoteUrl("http://127.0.0.1:8080/api", true),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeRemoteUrl("http://[::1]:8080/api", true),
    ).resolves.toBeUndefined();
  });

  it("classifies bracketed IPv6 URL literals before DNS resolution", async () => {
    await expect(
      assertSafeRemoteUrl("https://[::1]/api", false),
    ).rejects.toThrow("Private provider hosts");
  });

  it.each([
    "https://user:password@example.com/api",
    "https://example.com/api?token=secret",
    "https://example.com/api#fragment",
  ])("rejects ambiguous or credential-bearing URL %s", async (url) => {
    await expect(assertSafeRemoteUrl(url, false)).rejects.toThrow();
  });

  it("accepts a public HTTPS host after DNS validation", async () => {
    await expect(
      assertSafeRemoteUrl("https://1.1.1.1/api", false),
    ).resolves.toBeUndefined();
  });
});
