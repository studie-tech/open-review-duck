import { describe, expect, it } from "vitest";
import {
  applicableRepositoryRules,
  type RepositoryReviewRuleSnapshot,
  repositoryRuleDigest,
  repositoryRuleGlob,
} from "./rules";

const rule: RepositoryReviewRuleSnapshot = {
  id: "rule-1",
  version: 2,
  title: "Route ordering",
  instruction: "Keep utilities below routers.",
  pathGlob: "**/*.{ts,tsx}",
  scope: "file",
  severity: "medium",
};

describe("repository compliance rules", () => {
  it("matches root and nested paths with doublestar and braces", () => {
    const matcher = repositoryRuleGlob("**/*.{ts,tsx}");
    expect(matcher.test("router.ts")).toBe(true);
    expect(matcher.test("src/api/router.tsx")).toBe(true);
    expect(matcher.test("src/api/router.js")).toBe(false);
  });

  it("normalizes path separators and keeps file and repository scopes separate", () => {
    expect(
      applicableRepositoryRules([rule], ".\\src\\router.ts", "file"),
    ).toEqual([rule]);
    expect(
      applicableRepositoryRules([rule], "src/router.ts", "repository"),
    ).toEqual([]);
  });

  it("changes the digest on edits but not input ordering", () => {
    const second = { ...rule, id: "rule-2", title: "Folder layout" };
    expect(repositoryRuleDigest([rule, second])).toBe(
      repositoryRuleDigest([second, rule]),
    );
    expect(repositoryRuleDigest([rule])).not.toBe(
      repositoryRuleDigest([{ ...rule, version: 3 }]),
    );
  });
});
