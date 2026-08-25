import { describe, expect, it } from "vitest";
import { AI_PROMPT_KEYS } from "./ai-prompt-catalog";
import { AI_PROMPT_FLOWS, aiPromptFlowCoverage } from "./ai-prompt-flows";

describe("AI prompt flows", () => {
  it("places every catalog key on exactly one pipeline step", () => {
    const { missing, duplicate } = aiPromptFlowCoverage();
    expect(missing).toEqual([]);
    expect(duplicate).toEqual([]);
    expect(
      AI_PROMPT_FLOWS.flatMap((flow) =>
        flow.nodes.flatMap((node) => [...node.keys]),
      ).length,
    ).toBe(AI_PROMPT_KEYS.length);
  });

  it("keeps repository review on the deep-review pipeline", () => {
    const deepReview = AI_PROMPT_FLOWS.find(
      (flow) => flow.id === "deep_review",
    );
    expect(deepReview?.nodes.map((node) => node.id)).toEqual([
      "plan",
      "scout",
      "change",
      "validate",
      "survey",
      "dedupe",
    ]);
    expect(deepReview?.nodes.flatMap((node) => [...node.keys])).toContain(
      "deep_review.scout.system_repository",
    );
  });
});
