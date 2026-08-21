import { describe, expect, it } from "vitest";
import {
  repositoryReportFilename,
  repositoryReviewReport,
} from "./repository-review-report";

describe("repository review report", () => {
  it("includes only supplied findings and uses a safe fence for embedded ticks", () => {
    const report = repositoryReviewReport({
      repository: "acme/api",
      branch: "main",
      revision: "abc123",
      purpose: "code",
      findings: [
        {
          id: "finding-1",
          severity: "high",
          category: "correctness",
          title: "A real defect",
          body: "This breaks when empty.",
          path: "src/a.ts",
          startLine: 4,
          endLine: 5,
          existingCode: "```ts\nconst a = 1;\n```",
          suggestionCode: null,
        },
      ],
    });
    expect(report).toContain("Findings selected: 1");
    expect(report).toContain("src/a.ts:4-5");
    expect(report).toContain("````\n```ts");
  });

  it("makes branch names safe for downloads", () => {
    expect(
      repositoryReportFilename("Acme/API", "feature/a b", "compliance"),
    ).toBe("acme-api-feature-a-b-compliance-report.md");
  });
});
