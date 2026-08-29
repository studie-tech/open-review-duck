import { describe, expect, it } from "vitest";
import {
  hostnameFromHostHeader,
  isLoopbackHostname,
  isSafeLocalListenAddress,
  localListenAddressWarning,
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

  it.each(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::", ""])(
    "treats %s as a safe local listen address",
    (address) => expect(isSafeLocalListenAddress(address)).toBe(true),
  );

  it("warns when a local process would bind a public address", () => {
    expect(isSafeLocalListenAddress("192.168.1.20")).toBe(false);
    expect(localListenAddressWarning("192.168.1.20")).toMatch("192.168.1.20");
    expect(localListenAddressWarning("192.168.1.20", "3941")).toMatch(
      "127.0.0.1:3941:3941",
    );
    expect(localListenAddressWarning("127.0.0.1")).toBeUndefined();
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
