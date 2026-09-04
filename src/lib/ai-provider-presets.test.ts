import { describe, expect, it } from "vitest";
import {
  aiProviderCanVerifyModelFromList,
  aiProviderPresets,
  aiProviderRequiresApiKey,
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

  it("describes the documented Bedrock OpenAI-compatible connection", () => {
    expect(aiProviderPresets.bedrock).toMatchObject({
      label: "Amazon Bedrock",
      baseUrl: "",
      baseUrlPlaceholder:
        "https://bedrock-runtime.<region>.amazonaws.com/openai/v1",
      apiKeyRequired: true,
    });
    expect(aiProviderRequiresApiKey("bedrock")).toBe(true);
    expect(aiProviderCanVerifyModelFromList("bedrock")).toBe(true);
  });

  it("describes the documented Azure AI Foundry v1 connection", () => {
    expect(aiProviderPresets.azure_foundry).toMatchObject({
      label: "Azure AI Foundry",
      baseUrl: "",
      baseUrlPlaceholder: "https://<resource>.openai.azure.com/openai/v1",
      modelPlaceholder: "Deployment name",
      apiKeyRequired: true,
      modelListUsesConfiguredIds: false,
    });
    expect(aiProviderRequiresApiKey("azure_foundry")).toBe(true);
    expect(aiProviderCanVerifyModelFromList("azure_foundry")).toBe(false);
  });
});
