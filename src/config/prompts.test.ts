import { describe, expect, it } from "vitest";
import { REVIEWDUCK_AGENT_RUN_PROMPT, reviewDuckAgentPrompt } from "./prompts";

const pullRequest = {
  title: "Tighten authorization",
  description: "Update the request path.",
  sourceBranch: "feature/auth",
  targetBranch: "main",
};

describe("ReviewDuck agent prompts", () => {
  it("keeps repository content untrusted and review findings evidence-based", () => {
    const prompt = reviewDuckAgentPrompt({
      jobKind: "review",
      pullRequest,
    });

    expect(prompt).toContain("untrusted data");
    expect(prompt).toContain("compare it with current content");
    expect(prompt).toContain("seek evidence that could disprove it");
    expect(prompt).toContain("prefer an empty findings array");
    expect(prompt).not.toContain("No selected review unit was supplied");
  });

  it("strictly scopes explanations to the selected unit", () => {
    const prompt = reviewDuckAgentPrompt({
      jobKind: "explain",
      pullRequest,
      selectedUnit: {
        path: "src/auth.ts",
        name: "authorize",
        kind: "function",
        startLine: 20,
        endLine: 45,
        changedLineRanges: [
          { startLine: 24, endLine: 26 },
          { startLine: 39, endLine: 39 },
        ],
      },
    });

    expect(prompt).toContain('function "authorize"');
    expect(prompt).toContain("src/auth.ts, unit lines 20-45");
    expect(prompt).toContain("24-26, 39");
    expect(prompt).toContain("Never annotate unchanged context");
    expect(prompt).toContain("pull-request delta");
    expect(prompt).toContain("findings as an empty array");
    expect(prompt).toContain("<title>Tighten authorization</title>");
    expect(prompt).not.toContain("Act as a senior engineer reviewing");
  });

  it("keeps dependency-only explanations free of invented inline notes", () => {
    const prompt = reviewDuckAgentPrompt({
      jobKind: "explain",
      pullRequest,
      selectedUnit: {
        path: "src/session.ts",
        name: "loadSession",
        kind: "function",
        startLine: 10,
        endLine: 18,
        changedLineRanges: [],
      },
    });

    expect(prompt).toContain("no directly changed displayed lines");
    expect(prompt).toContain("return no inline annotations");
  });

  it("uses a read-only dispatch prompt", () => {
    expect(REVIEWDUCK_AGENT_RUN_PROMPT).toContain("do not modify");
    expect(REVIEWDUCK_AGENT_RUN_PROMPT).toContain("submit");
  });
});
