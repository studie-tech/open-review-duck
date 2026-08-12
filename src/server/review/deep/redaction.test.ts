import { describe, expect, it } from "vitest";
import { sanitizeReason } from "./redaction";

const jwt =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("sanitizeReason", () => {
  it("keeps the host but removes URL credentials", () => {
    const reason = sanitizeReason(
      "connect failed for https://deploy:hunter2@git.example.com/org/repo.git",
    );
    expect(reason).toBe(
      "connect failed for https://REDACTED@git.example.com/org/repo.git",
    );
    expect(reason).not.toContain("hunter2");
    expect(reason).not.toContain("deploy:");
  });

  it("removes credentials from non-http schemes", () => {
    const reason = sanitizeReason(
      "postgres://app:s3cr3t@db.internal:5432/main",
    );
    expect(reason).toContain("postgres://REDACTED@db.internal:5432/main");
    expect(reason).not.toContain("s3cr3t");
  });

  it("removes the whole Authorization header value", () => {
    const reason = sanitizeReason(
      "upstream rejected request (Authorization: Bearer abc123def456ghi789)",
    );
    expect(reason).toContain("Authorization: [REDACTED]");
    expect(reason).not.toContain("abc123def456ghi789");
  });

  it("removes basic credentials from an Authorization header", () => {
    const reason = sanitizeReason("Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(reason).not.toContain("dXNlcjpwYXNzd29yZA");
  });

  it("removes a bare bearer token", () => {
    const reason = sanitizeReason("retry with Bearer sk_live_9f8e7d6c5b4a3210");
    expect(reason).toBe("retry with Bearer [REDACTED]");
    expect(reason).not.toContain("9f8e7d6c5b4a3210");
  });

  it("removes OpenAI-style keys including project keys", () => {
    const classic = sanitizeReason(
      "invalid key sk-abcdefghijklmnopqrstuvwxyz012345 supplied",
    );
    expect(classic).toBe("invalid key [REDACTED] supplied");
    const project = sanitizeReason(
      "invalid key sk-proj-abcdefghijklmnopqrstuvwxyz012345 supplied",
    );
    expect(project).toBe("invalid key [REDACTED] supplied");
    expect(project).not.toContain("abcdefghijklmnop");
  });

  it("removes every GitHub token prefix", () => {
    for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
      const token = `${prefix}_16C7e42F292c6912E7710c838347Ae178B4a`;
      const reason = sanitizeReason(`bad credentials for ${token}`);
      expect(reason).toBe("bad credentials for [REDACTED]");
      expect(reason).not.toContain("16C7e42F292c6912");
    }
  });

  it("removes AWS access key ids", () => {
    const reason = sanitizeReason(
      "denied for AKIAIOSFODNN7EXAMPLE in us-east-1",
    );
    expect(reason).toBe("denied for [REDACTED] in us-east-1");
  });

  it("removes assignment-shaped secrets with quoted and bare values", () => {
    expect(sanitizeReason('api_key = "abcd-1234-efgh"')).toBe(
      "api_key = [REDACTED]",
    );
    expect(sanitizeReason("apikey: abcd1234efgh")).toBe("apikey: [REDACTED]");
    expect(sanitizeReason("token=abcd1234efgh")).toBe("token=[REDACTED]");
    expect(sanitizeReason("secret='abcd1234efgh'")).toBe("secret=[REDACTED]");
    expect(sanitizeReason("password=hunter2")).toBe("password=[REDACTED]");
    expect(sanitizeReason('{"access_token": "abcd1234efgh"}')).toContain(
      '{"access_token": [REDACTED]}',
    );
    expect(sanitizeReason("x-api-key: abcd1234efgh")).toBe(
      "x-api-key: [REDACTED]",
    );
  });

  it("removes JWTs wherever they appear", () => {
    const reason = sanitizeReason(`token rejected: ${jwt} (exp)`);
    expect(reason).toBe("token rejected: [REDACTED] (exp)");
    expect(reason).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(reason).not.toContain("dBjftJeZ4CVP");
  });

  it("removes three-segment tokens that lack a JWT header", () => {
    const opaque =
      "QUJDREVGR0hJSktMTU5PUA.UVJTVFVWV1hZWjAxMjM0NQ.Njc4OUFCQ0RFRkdISUpL";
    const reason = sanitizeReason(`session ${opaque} expired`);
    expect(reason).toBe("session [REDACTED] expired");
  });

  it("keeps dotted hostnames and versions readable", () => {
    expect(sanitizeReason("api.openai.com returned 429 for v1.2.3")).toBe(
      "api.openai.com returned 429 for v1.2.3",
    );
  });

  it("removes sensitive query-string parameters only", () => {
    const reason = sanitizeReason(
      "GET https://api.example.com/v1/files?path=src/a.ts&api_key=abc123&X-Amz-Signature=deadbeefcafe&access_token=zzz9&secret=q1&password=p2 failed",
    );
    expect(reason).toContain("path=src/a.ts");
    expect(reason).toContain("api_key=[REDACTED]");
    expect(reason).toContain("X-Amz-Signature=[REDACTED]");
    expect(reason).toContain("access_token=[REDACTED]");
    for (const value of ["abc123", "deadbeefcafe", "zzz9", "q1", "p2"]) {
      expect(reason).not.toContain(value);
    }
  });

  it("removes private key material", () => {
    const reason = sanitizeReason(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----",
    );
    expect(reason).toBe("[REDACTED]");
  });

  it("leaves no secret behind when a message carries several at once", () => {
    const secrets = [
      "deploy:hunter2",
      "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      "AKIAIOSFODNN7EXAMPLE",
      jwt,
      "swordfish9000",
      "sigvalue7788",
    ];
    const reason = sanitizeReason(
      [
        "clone https://deploy:hunter2@git.example.com/org/repo.git failed;",
        "Authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz012345;",
        "gh token ghp_16C7e42F292c6912E7710c838347Ae178B4a;",
        "aws AKIAIOSFODNN7EXAMPLE;",
        `jwt ${jwt};`,
        "password=swordfish9000;",
        "callback https://cb.example.com/x?signature=sigvalue7788&ok=1",
      ].join(" "),
      { maxLength: 4_000 },
    );
    for (const secret of secrets) {
      expect(reason).not.toContain(secret);
    }
    expect(reason).not.toContain("hunter2");
    expect(reason).not.toContain("abcdefghijkl");
    expect(reason).toContain("git.example.com/org/repo.git");
    expect(reason).toContain("ok=1");
  });

  it("uses the message of an Error and never its stack", () => {
    const error = new Error("upstream timed out");
    expect(sanitizeReason(error)).toBe("upstream timed out");
    expect(sanitizeReason(error)).not.toContain("redaction.test");
  });

  it("redacts the message of an Error subclass", () => {
    class ProviderError extends Error {}
    const reason = sanitizeReason(
      new ProviderError("401 from https://u:p@api.example.com/v1"),
    );
    expect(reason).toBe("401 from https://REDACTED@api.example.com/v1");
  });

  it("falls back for values that are neither Error nor string", () => {
    expect(sanitizeReason(undefined)).toBe("An unexpected error occurred");
    expect(sanitizeReason(null)).toBe("An unexpected error occurred");
    expect(sanitizeReason(42)).toBe("An unexpected error occurred");
    expect(sanitizeReason({ message: "sk-abcdefghijklmnop" })).toBe(
      "An unexpected error occurred",
    );
    expect(sanitizeReason(["sk-abcdefghijklmnop"])).toBe(
      "An unexpected error occurred",
    );
  });

  it("falls back for blank input", () => {
    expect(sanitizeReason("")).toBe("An unexpected error occurred");
    expect(sanitizeReason("   \n\t ")).toBe("An unexpected error occurred");
    expect(sanitizeReason(new Error(""))).toBe("An unexpected error occurred");
  });

  it("collapses whitespace runs and trims", () => {
    expect(sanitizeReason("  first line\n\n\tsecond   line  ")).toBe(
      "first line second line",
    );
  });

  it("truncates to 500 characters by default with an ellipsis", () => {
    const reason = sanitizeReason("a".repeat(600));
    expect(reason).toHaveLength(500);
    expect(reason.endsWith("…")).toBe(true);
    expect(reason.slice(0, 499)).toBe("a".repeat(499));
  });

  it("honors a caller-supplied maximum length", () => {
    const reason = sanitizeReason("b".repeat(100), { maxLength: 20 });
    expect(reason).toHaveLength(20);
    expect(reason).toBe(`${"b".repeat(19)}…`);
  });

  it("leaves short messages untouched by truncation", () => {
    expect(sanitizeReason("short", { maxLength: 5 })).toBe("short");
    expect(sanitizeReason("short")).toBe("short");
  });

  it("ignores an unusable maximum length", () => {
    expect(
      sanitizeReason("c".repeat(600), { maxLength: Number.NaN }),
    ).toHaveLength(500);
    expect(sanitizeReason("hello", { maxLength: 0 })).toBe("…");
  });

  it("truncates only after redacting, so no secret head survives a cut", () => {
    const reason = sanitizeReason(
      `sk-proj-abcdefghijklmnopqrstuvwxyz012345 ${"x".repeat(600)}`,
      { maxLength: 30 },
    );
    expect(reason).not.toContain("sk-proj-");
    expect(reason.startsWith("[REDACTED]")).toBe(true);
    expect(reason).toHaveLength(30);
  });

  it("is stable when applied twice", () => {
    const once = sanitizeReason(
      `https://u:p@host/x?token=abc123 Authorization: Bearer ${jwt} password=pw12345678`,
    );
    expect(sanitizeReason(once)).toBe(once);
  });
});
