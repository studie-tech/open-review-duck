import { describe, expect, it } from "vitest";
import { defaultAiPromptBodies } from "~/server/ai/prompt-defaults";
import {
  AI_PROMPT_CATALOG,
  AI_PROMPT_KEYS,
  isAiPromptKey,
} from "./ai-prompt-catalog";
import { aiPromptFlowCoverage } from "./ai-prompt-flows";
import { renderAiPromptTemplate } from "./ai-prompt-template";

describe("renderAiPromptTemplate", () => {
  it("replaces known tokens and leaves unknown tokens in place", () => {
    expect(
      renderAiPromptTemplate("Hello {{name}}. Keep {{unknown}}.", {
        name: "ReviewDuck",
      }),
    ).toBe("Hello ReviewDuck. Keep {{unknown}}.");
  });
});

describe("AI prompt catalog", () => {
  it("registers unique keys for every shipped prompt", () => {
    expect(new Set(AI_PROMPT_KEYS).size).toBe(AI_PROMPT_KEYS.length);
    expect(Object.keys(AI_PROMPT_CATALOG)).toEqual(AI_PROMPT_KEYS);
    expect(
      [
        ...new Set(Object.values(AI_PROMPT_CATALOG).map(({ group }) => group)),
      ].sort(),
    ).toEqual(["Deep review", "Explanations", "Grouping"]);
    expect(isAiPromptKey("explain.system")).toBe(true);
    expect(isAiPromptKey("not.a.prompt")).toBe(false);
    const bodies = defaultAiPromptBodies();
    for (const key of AI_PROMPT_KEYS) {
      expect(bodies[key].length).toBeGreaterThan(0);
    }
    expect(aiPromptFlowCoverage()).toEqual({ missing: [], duplicate: [] });
  });
});
