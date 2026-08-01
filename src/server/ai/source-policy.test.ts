import { describe, expect, it } from "vitest";
import {
  bigPickleIgnoreMatcher,
  bigPickleSourceDecision,
} from "./source-policy";

describe("Big Pickle source policy", () => {
  it("blocks secret-bearing and credential paths", () => {
    expect(bigPickleSourceDecision(".env", "SAFE=value").allowed).toBe(false);
    expect(
      bigPickleSourceDecision(
        "src/config.ts",
        'apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz"',
      ).allowed,
    ).toBe(false);
  });

  it("allows ordinary reviewed source", () => {
    expect(
      bigPickleSourceDecision(
        "src/review.ts",
        "export function review() { return true; }",
      ),
    ).toEqual({ allowed: true });
  });

  it("honors root and nested repository AI ignore policies", () => {
    const ignored = bigPickleIgnoreMatcher([
      { path: ".gitignore", source: "generated/\n*.pem\n" },
      {
        path: "packages/private/.openreviewignore",
        source: "fixtures/\ninternal.ts\n",
      },
    ]);
    expect(ignored("generated/client.ts")).toBe(true);
    expect(ignored("src/key.pem")).toBe(true);
    expect(ignored("packages/private/fixtures/data.ts")).toBe(true);
    expect(ignored("packages/private/internal.ts")).toBe(true);
    expect(ignored("packages/public/internal.ts")).toBe(false);
  });
});
