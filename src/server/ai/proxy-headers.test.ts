import { describe, expect, it } from "vitest";
import { setSafeProxyHeader } from "./proxy-headers";

describe("AI proxy headers", () => {
  it("preserves ordinary model headers", () => {
    const headers = new Headers();
    setSafeProxyHeader(headers, "anthropic-version", "2023-06-01");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it.each([
    "Host",
    "Connection",
    "Content-Length",
    "Transfer-Encoding",
    "Authorization",
    "X-Api-Key",
    "X-Forwarded-Host",
  ])("blocks the routing or credential header %s", (name) => {
    const headers = new Headers();
    setSafeProxyHeader(headers, name, "attacker-controlled");
    expect(headers.has(name)).toBe(false);
  });
});
