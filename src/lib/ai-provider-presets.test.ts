import { describe, expect, it } from "vitest";
import {
  aiProviderPresets,
  localDefaultAiPreset,
  matchingAiProviderPreset,
} from "./ai-provider-presets";

describe("AI provider presets", () => {
  it("uses Big Pickle through OpenCode's compatible endpoint for local setup", () => {
    expect(localDefaultAiPreset).toMatchObject({
      provider: "opencode",
      model: "big-pickle",
      protocol: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
    });
  });

  it("keeps arbitrary providers fully configurable", () => {
    expect(matchingAiProviderPreset("private-gateway")).toBe("custom");
    expect(aiProviderPresets.custom.baseUrl).toBe("");
  });
});
