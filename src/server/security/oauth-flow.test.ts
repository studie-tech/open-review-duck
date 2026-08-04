import { describe, expect, it } from "vitest";
import {
  GITHUB_USER_AUTHORIZATION_STAGE,
  githubAuthorizationInstallationId,
  githubInstallationId,
  safeOAuthRedirectPath,
} from "./oauth-flow";

describe("safeOAuthRedirectPath", () => {
  it.each([
    ["/settings/providers", "/settings/providers"],
    [
      "/settings/providers?connected=1#github",
      "/settings/providers?connected=1#github",
    ],
    ["//attacker.example/steal", "/settings/providers"],
    ["/\\attacker.example/steal", "/settings/providers"],
    ["/..//attacker.example", "/settings/providers"],
    ["/./..//attacker.example/path", "/settings/providers"],
    ["https://attacker.example/steal", "/settings/providers"],
    [undefined, "/settings/providers"],
  ])(
    "normalizes %s without allowing a cross-origin redirect",
    (value, expected) => {
      expect(safeOAuthRedirectPath(value, "https://reviewduck.example")).toBe(
        expected,
      );
    },
  );
});

describe("githubInstallationId", () => {
  it.each(["1", "12345678901234567890"])("accepts %s", (value) => {
    expect(githubInstallationId(value)).toBe(value);
  });

  it.each([
    undefined,
    "",
    "0",
    "-1",
    "+1",
    "1.5",
    "1e3",
    " 1",
    "123456789012345678901",
  ])("rejects %s", (value) => {
    expect(githubInstallationId(value)).toBeUndefined();
  });
});

describe("githubAuthorizationInstallationId", () => {
  it("accepts matching signed and encrypted installation identifiers", () => {
    expect(
      githubAuthorizationInstallationId(
        {
          stage: GITHUB_USER_AUTHORIZATION_STAGE,
          installationId: "151122863",
        },
        "151122863",
      ),
    ).toBe("151122863");
  });

  it("uses the signed installation identifier when the encrypted copy is absent", () => {
    expect(
      githubAuthorizationInstallationId(
        {
          stage: GITHUB_USER_AUTHORIZATION_STAGE,
          installationId: "151122863",
        },
        undefined,
      ),
    ).toBe("151122863");
  });

  it("keeps existing in-flight encrypted states compatible", () => {
    expect(githubAuthorizationInstallationId({}, "151122863")).toBe(
      "151122863",
    );
  });

  it.each([
    [{ stage: "wrong", installationId: "151122863" }, "151122863"],
    [
      {
        stage: GITHUB_USER_AUTHORIZATION_STAGE,
        installationId: "151122864",
      },
      "151122863",
    ],
    [
      {
        stage: GITHUB_USER_AUTHORIZATION_STAGE,
        installationId: "invalid",
      },
      "151122863",
    ],
  ])("rejects mismatched or invalid signed claims", (claims, encrypted) => {
    expect(
      githubAuthorizationInstallationId(claims, encrypted),
    ).toBeUndefined();
  });
});
