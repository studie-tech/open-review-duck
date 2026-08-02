import type { AiProtocol } from "~/validators/ai";

export interface AiProviderPresetDefinition {
  label: string;
  protocol: AiProtocol;
  baseUrl: string;
  defaultModel?: string;
}

export const aiProviderPresets = {
  opencode: {
    label: "OpenCode Zen",
    protocol: "openai-completions",
    baseUrl: "https://opencode.ai/zen/v1",
    defaultModel: "big-pickle",
  },
  openai: {
    label: "OpenAI",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  },
  anthropic: {
    label: "Anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
  },
  azure_openai: {
    label: "Azure OpenAI",
    protocol: "azure-openai-responses",
    baseUrl: "",
  },
  google: {
    label: "Google AI",
    protocol: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com",
  },
  openrouter: {
    label: "OpenRouter",
    protocol: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  mistral: {
    label: "Mistral",
    protocol: "mistral-conversations",
    baseUrl: "https://api.mistral.ai/v1",
  },
  ollama: {
    label: "Ollama",
    protocol: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
  },
  custom: {
    label: "Custom",
    protocol: "openai-completions",
    baseUrl: "",
  },
} as const satisfies Record<string, AiProviderPresetDefinition>;

export type AiProviderPreset = keyof typeof aiProviderPresets;

export const localDefaultAiPreset = {
  provider: "opencode",
  model: "big-pickle",
  ...aiProviderPresets.opencode,
} as const;

/** Finds the known preset matching a stored provider identifier. */
export function matchingAiProviderPreset(provider: string): AiProviderPreset {
  return provider in aiProviderPresets
    ? (provider as AiProviderPreset)
    : "custom";
}
