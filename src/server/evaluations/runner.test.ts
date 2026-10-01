import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateText: mocks.generate,
}));

import type { ResolvedAiModel } from "~/server/ai/models";
import { defaultAiPromptBodies } from "~/server/ai/prompt-defaults";
import { evaluateCase } from "./runner";
import type { EvalSnapshot } from "./store";

const example = {
  id: "case-1",
  title: "SECRET ANSWER TITLE",
  path: "a.ts",
  source: "function a(user) { return user.name; }",
  previousSource: "",
  finding: "SECRET TARGET FINDING",
  existingCode: "user.name",
  label: "bug" as const,
  rationale: "SECRET LABEL REASON",
  split: "development" as const,
};
const model = {} as ResolvedAiModel;
/** Builds a fresh immutable experiment fixture. */
function snapshot(mode: EvalSnapshot["mode"]): EvalSnapshot {
  return {
    version: 1,
    mode,
    split: "development",
    model: "fixture",
    provider: "fixture",
    prompts: defaultAiPromptBodies(),
    cases: [example],
  };
}
beforeEach(() => {
  mocks.generate.mockReset();
});

describe("frozen review runner", () => {
  it("does not leak expected answers into discovery and requires human matching", async () => {
    mocks.generate.mockImplementation(async (request) => {
      expect(request.prompt).not.toContain("SECRET");
      expect(request.prompt).toContain(example.source);
      expect(request.system).toBe(
        snapshot("discovery").prompts["deep_review.scout.system_repository"],
      );
      await request.tools.report_finding.execute({
        findings: [
          {
            title: "Unrelated bug",
            body: "Different issue",
            existing_code: "user",
            severity: "high",
            category: "bug",
          },
        ],
      });
      await request.tools.finish_file.execute({ summary: "Done" });
      return {
        text: "Done",
        totalUsage: { inputTokens: 10, outputTokens: 20 },
      };
    });
    const result = await evaluateCase(snapshot("discovery"), example, model);
    expect(result.prediction).toBe("ungraded");
    expect(result.inputTokens).toBe(10);
  });
  it("treats an unfinished scout as failure even with no findings", async () => {
    mocks.generate.mockResolvedValue({ text: "", totalUsage: {} });
    expect(
      (await evaluateCase(snapshot("discovery"), example, model)).prediction,
    ).toBe("error");
  });
  it("scores a completed empty discovery as no target reported", async () => {
    mocks.generate.mockImplementation(async (request) => {
      await request.tools.finish_file.execute({ summary: "Clean" });
      return { text: "", totalUsage: {} };
    });
    expect(
      (await evaluateCase(snapshot("discovery"), example, model)).prediction,
    ).toBe("suppress");
  });
  it.each([
    "not json",
    '{"votes":[]}',
    '{"votes":[{"id":"case-1","verdict":"refuted"}]}',
    '{"votes":[{"id":"case-1","verdict":"not_refuted"},{"id":"case-1","verdict":"not_refuted"}]}',
  ])("does not reward an unusable refuter response: %s", async (text) => {
    mocks.generate.mockResolvedValue({ text, totalUsage: {} });
    expect(
      (await evaluateCase(snapshot("verification"), example, model)).prediction,
    ).toBe("error");
  });
  it("uses the production evidence policy for refutations", async () => {
    mocks.generate.mockResolvedValue({
      text: JSON.stringify({
        votes: [
          {
            id: example.id,
            verdict: "refuted",
            refutation: "The guard prevents it",
            evidencePath: "a.ts",
            evidenceLine: 1,
          },
        ],
      }),
      totalUsage: {},
    });
    expect(
      (await evaluateCase(snapshot("verification"), example, model)).prediction,
    ).toBe("suppress");
    expect(mocks.generate.mock.calls[0]?.[0].prompt).not.toContain(
      example.rationale,
    );
  });
});
