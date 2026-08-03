export interface AiProviderPresetDefinition {
  label: string;
  baseUrl: string;
  defaultModel?: string;
}

export const aiProviderPresets = {
  opencode: {
    label: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    defaultModel: "big-pickle",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
  },
  custom: {
    label: "Custom",
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
