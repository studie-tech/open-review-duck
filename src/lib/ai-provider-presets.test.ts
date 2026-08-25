import { describe, expect, it } from "vitest";
import {
  aiProviderPresets,
  matchingAiProviderPreset,
} from "./ai-provider-presets";

describe("AI provider presets", () => {
  it("lists OpenCode Zen as an ordinary compatible endpoint", () => {
    expect(aiProviderPresets.opencode).toEqual({
      label: "OpenCode Zen",
      baseUrl: "https://opencode.ai/zen/v1",
    });
  });

  it("keeps arbitrary providers fully configurable", () => {
    expect(matchingAiProviderPreset("private-gateway")).toBe("custom");
    expect(aiProviderPresets.custom.baseUrl).toBe("");
  });
});
