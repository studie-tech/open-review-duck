import { describe, expect, it } from "vitest";
import {
  aiIgnoreMatcher,
  isAiIgnoreFilePath,
  reviewIgnoreFileSource,
  sourcePolicyDecision,
} from "./source-policy";

describe("source policy", () => {
  it("blocks secret-bearing and credential paths", () => {
    expect(sourcePolicyDecision(".env", "SAFE=value").allowed).toBe(false);
    expect(
      sourcePolicyDecision(
        "src/config.ts",
        'apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz"',
      ).allowed,
    ).toBe(false);
  });

  it("allows ordinary reviewed source", () => {
    expect(
      sourcePolicyDecision(
        "src/review.ts",
        "export function review() { return true; }",
      ),
    ).toEqual({ allowed: true });
  });

  it("honors root and nested repository AI ignore policies", () => {
    const ignored = aiIgnoreMatcher([
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

  it("recognizes root and nested ignore files", () => {
    expect(isAiIgnoreFilePath(".gitignore")).toBe(true);
    expect(isAiIgnoreFilePath(".openreviewignore")).toBe(true);
    expect(isAiIgnoreFilePath("packages/private/.gitignore")).toBe(true);
    expect(isAiIgnoreFilePath("src/auth.ts")).toBe(false);
  });

  it("keeps only the base revision of a changed ignore file", () => {
    expect(
      reviewIgnoreFileSource({
        changed: true,
        current: "src/**\n",
        previous: "docs/\n",
      }),
    ).toBe("docs/\n");
    expect(
      reviewIgnoreFileSource({
        changed: true,
        current: "src/**\n",
      }),
    ).toBeUndefined();
    expect(
      reviewIgnoreFileSource({
        changed: false,
        current: "generated/\n",
      }),
    ).toBe("generated/\n");
  });
});
