import { describe, expect, it } from "vitest";
import {
  hostnameFromHostHeader,
  isLoopbackHostname,
  workflowUsesApplicationDatabase,
} from "./deployment";

describe("deployment boundaries", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]"])(
    "accepts the loopback hostname %s",
    (hostname) => expect(isLoopbackHostname(hostname)).toBe(true),
  );

  it.each(["reviewduck.local", "192.168.1.20", "0.0.0.0", "example.com"])(
    "rejects the non-loopback hostname %s",
    (hostname) => expect(isLoopbackHostname(hostname)).toBe(false),
  );

  it.each([
    ["localhost:3666", "localhost"],
    ["127.0.0.1:3666", "127.0.0.1"],
    ["[::1]:3666", "[::1]"],
    ["not a host", ""],
    [null, ""],
  ])("extracts the hostname from %s", (host, expected) => {
    expect(hostnameFromHostHeader(host)).toBe(expected);
  });

  it("checks Workflow tables only for the explicit PostgreSQL world", () => {
    expect(workflowUsesApplicationDatabase("@workflow/world-postgres")).toBe(
      true,
    );
    expect(workflowUsesApplicationDatabase(undefined)).toBe(false);
    expect(workflowUsesApplicationDatabase("@workflow/world-vercel")).toBe(
      false,
    );
  });
});
