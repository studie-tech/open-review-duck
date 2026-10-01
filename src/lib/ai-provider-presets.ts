export interface AiProviderPresetDefinition {
  label: string;
  baseUrl: string;
  baseUrlPlaceholder?: string;
  modelPlaceholder?: string;
  apiKeyLabel?: string;
  apiKeyPlaceholder?: string;
  apiKeyRequired?: boolean;
  modelListUsesConfiguredIds?: boolean;
  connectionHelp?: string;
  documentationUrl?: string;
}

export const aiProviderPresets = {
  opencode: {
    label: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
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
  bedrock: {
    label: "Amazon Bedrock",
    baseUrl: "",
    baseUrlPlaceholder:
      "https://bedrock-runtime.<region>.amazonaws.com/openai/v1",
    modelPlaceholder: "Model ID returned by the endpoint",
    apiKeyLabel: "Amazon Bedrock API key",
    apiKeyPlaceholder: "Paste a Bedrock API key",
    apiKeyRequired: true,
    connectionHelp:
      "Use the OpenAI-compatible Bedrock Runtime URL for the model's AWS Region. Choose a model returned by that endpoint.",
    documentationUrl:
      "https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html",
  },
  azure_foundry: {
    label: "Azure AI Foundry",
    baseUrl: "",
    baseUrlPlaceholder: "https://<resource>.openai.azure.com/openai/v1",
    modelPlaceholder: "Deployment name",
    apiKeyLabel: "Foundry resource API key",
    apiKeyPlaceholder: "Paste a Foundry resource API key",
    apiKeyRequired: true,
    modelListUsesConfiguredIds: false,
    connectionHelp:
      "Use your Foundry resource's OpenAI v1 endpoint. Enter the deployment name, not the catalog model ID, and choose a deployment that supports Chat Completions.",
    documentationUrl:
      "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints",
  },
  custom: {
    label: "Custom",
    baseUrl: "",
  },
} as const satisfies Record<string, AiProviderPresetDefinition>;

export type AiProviderPreset = keyof typeof aiProviderPresets;

/** Returns a preset through its shared definition shape. */
export function aiProviderPresetDefinition(
  preset: AiProviderPreset,
): AiProviderPresetDefinition {
  return aiProviderPresets[preset];
}

/** Whether a built-in provider requires a bearer API key. */
export function aiProviderRequiresApiKey(provider: string) {
  if (!(provider in aiProviderPresets)) return false;
  return Boolean(
    aiProviderPresetDefinition(provider as AiProviderPreset).apiKeyRequired,
  );
}

/** Whether GET /models returns the identifiers used in inference requests. */
export function aiProviderCanVerifyModelFromList(provider: string) {
  if (!(provider in aiProviderPresets)) return true;
  return (
    aiProviderPresetDefinition(provider as AiProviderPreset)
      .modelListUsesConfiguredIds !== false
  );
}

/** Finds the known preset matching a stored provider identifier. */
export function matchingAiProviderPreset(provider: string): AiProviderPreset {
  return provider in aiProviderPresets
    ? (provider as AiProviderPreset)
    : "custom";
}
