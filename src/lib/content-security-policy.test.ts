import { describe, expect, it } from "vitest";
import { localContentSecurityPolicy } from "./content-security-policy";

describe("localContentSecurityPolicy", () => {
  it("uses a nonce without allowing arbitrary inline or remote scripts", () => {
    const policy = localContentSecurityPolicy("nonce-value", false);

    expect(policy).toContain("'nonce-nonce-value'");
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain("script-src 'self' https:");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it("allows eval only for development tooling", () => {
    expect(localContentSecurityPolicy("nonce", true)).toContain(
      "'unsafe-eval'",
    );
  });
});
