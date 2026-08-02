import { describe, expect, it } from "vitest";
import { normalizeAzureOrganizationUrl } from "./azure-organization-url";

describe("normalizeAzureOrganizationUrl", () => {
  it.each([
    ["https://dev.azure.com/acme/", "https://dev.azure.com/acme"],
    ["https://acme.visualstudio.com/", "https://acme.visualstudio.com"],
  ])("normalizes supported organization URL %s", (input, expected) => {
    expect(normalizeAzureOrganizationUrl(input)).toBe(expected);
  });

  it.each([
    "not a URL",
    "http://dev.azure.com/acme",
    "https://dev.azure.com",
    "https://dev.azure.com/acme/project",
    "https://attacker.example/acme",
    "https://dev.azure.com@attacker.example/acme",
  ])("rejects malformed or non-service URL %s", (input) => {
    expect(() => normalizeAzureOrganizationUrl(input)).toThrow();
  });
});
