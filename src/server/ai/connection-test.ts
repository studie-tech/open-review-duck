import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamAzureOpenAi } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { streamSimple as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as streamGoogleVertex } from "@earendil-works/pi-ai/api/google-vertex";
import { streamSimple as streamMistral } from "@earendil-works/pi-ai/api/mistral-conversations";
import { streamSimple as streamOpenAiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import {
  AI_CONNECTION_TEST_SYSTEM_PROMPT,
  AI_CONNECTION_TEST_TOOL_DESCRIPTIONS,
  AI_CONNECTION_TEST_USER_PROMPT,
} from "~/config/prompts";
import type { VerifiedAiConfiguration } from "./configuration-verification";

const DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com",
  mistral: "https://api.mistral.ai/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

/** Sends the verification prompt through the configured model protocol. */
function testModel(
  configuration: VerifiedAiConfiguration,
): Model<VerifiedAiConfiguration["apiProtocol"]> {
  const baseUrl =
    configuration.baseUrl ?? DEFAULT_BASE_URLS[configuration.provider];
  if (!baseUrl) throw new Error("A base URL is required for this provider");

  return {
    id: configuration.model,
    name: configuration.model,
    api: configuration.apiProtocol,
    provider: configuration.provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: configuration.contextWindow,
    maxTokens: configuration.maxTokens,
    headers: configuration.headers,
  };
}

/** Consumes a provider stream and returns the completed assistant response. */
function streamTestRequest(
  model: Model<VerifiedAiConfiguration["apiProtocol"]>,
  context: Context,
  options: SimpleStreamOptions,
) {
  switch (model.api) {
    case "anthropic-messages":
      return streamAnthropic(
        model as Model<"anthropic-messages">,
        context,
        options,
      );
    case "azure-openai-responses":
      return streamAzureOpenAi(
        model as Model<"azure-openai-responses">,
        context,
        options,
      );
    case "google-generative-ai":
      return streamGoogle(
        model as Model<"google-generative-ai">,
        context,
        options,
      );
    case "google-vertex":
      return streamGoogleVertex(
        model as Model<"google-vertex">,
        context,
        options,
      );
    case "mistral-conversations":
      return streamMistral(
        model as Model<"mistral-conversations">,
        context,
        options,
      );
    case "openai-completions":
      return streamOpenAiCompletions(
        model as Model<"openai-completions">,
        context,
        options,
      );
    case "openai-responses":
      return streamOpenAiResponses(
        model as Model<"openai-responses">,
        context,
        options,
      );
  }
}

type TestStreamRequest = (
  model: Model<VerifiedAiConfiguration["apiProtocol"]>,
  context: Context,
  options: SimpleStreamOptions,
) => { result: () => Promise<AssistantMessage> };

/** Validates that a model test produced a usable assistant response. */
function assertSuccessfulResponse(response: AssistantMessage) {
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(
      response.errorMessage || "The provider rejected the request",
    );
  }
}

/** Builds safe request options for a model connection test. */
function testRequestOptions(
  configuration: VerifiedAiConfiguration,
): SimpleStreamOptions {
  const usesResponsesApi =
    configuration.apiProtocol === "openai-responses" ||
    configuration.apiProtocol === "azure-openai-responses";

  return {
    apiKey: configuration.apiKey,
    headers: configuration.headers,
    maxTokens: Math.min(configuration.maxTokens, 128),
    maxRetries: 0,
    timeoutMs: 30_000,
    onPayload: usesResponsesApi
      ? (payload) => ({
          ...(payload as Record<string, unknown>),
          store: configuration.storeResponses,
        })
      : undefined,
  };
}

/** Runs an end-to-end model workflow test for a BYOK configuration. */
export async function testAiProviderConnection(
  configuration: VerifiedAiConfiguration,
  request: TestStreamRequest = streamTestRequest,
) {
  const startedAt = performance.now();
  const model = testModel(configuration);
  const userMessage = {
    role: "user" as const,
    content: AI_CONNECTION_TEST_USER_PROMPT,
    timestamp: Date.now(),
  };
  const readTool = {
    name: "read_reviewduck_diagnostic",
    description: AI_CONNECTION_TEST_TOOL_DESCRIPTIONS.read,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } as NonNullable<Context["tools"]>[number];
  const submitTool = {
    name: "submit_reviewduck_diagnostic",
    description: AI_CONNECTION_TEST_TOOL_DESCRIPTIONS.submit,
    parameters: {
      type: "object",
      properties: { answer: { type: "number" } },
      required: ["answer"],
      additionalProperties: false,
    },
  } as NonNullable<Context["tools"]>[number];
  const tools = [readTool, submitTool];
  const firstResponse = await request(
    model,
    {
      systemPrompt: AI_CONNECTION_TEST_SYSTEM_PROMPT,
      messages: [userMessage],
      tools,
    },
    testRequestOptions(configuration),
  ).result();
  assertSuccessfulResponse(firstResponse);
  const toolCall = firstResponse.content.find(
    (content) =>
      content.type === "toolCall" &&
      content.name === "read_reviewduck_diagnostic",
  );
  if (toolCall?.type !== "toolCall") {
    throw new Error(
      "The model did not call the required diagnostic tool. ReviewDuck requires a model with tool-calling support",
    );
  }

  const secondResponse = await request(
    model,
    {
      systemPrompt: AI_CONNECTION_TEST_SYSTEM_PROMPT,
      messages: [
        userMessage,
        firstResponse,
        {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [
            {
              type: "text",
              text: "export function diagnosticValue() { return 6 * 7; }",
            },
          ],
          isError: false,
          timestamp: Date.now(),
        },
      ],
      tools,
    },
    testRequestOptions(configuration),
  ).result();
  assertSuccessfulResponse(secondResponse);
  const submitCall = secondResponse.content.find(
    (content) =>
      content.type === "toolCall" &&
      content.name === "submit_reviewduck_diagnostic",
  );
  if (submitCall?.type !== "toolCall") {
    throw new Error(
      "The model did not complete the diagnostic tool workflow. ReviewDuck requires reliable multi-step tool calling",
    );
  }
  if (submitCall.arguments.answer !== 42) {
    throw new Error(
      "The model called the diagnostic tool with an incorrect structured result. ReviewDuck requires dependable tool arguments",
    );
  }

  const thirdResponse = await request(
    model,
    {
      systemPrompt: AI_CONNECTION_TEST_SYSTEM_PROMPT,
      messages: [
        userMessage,
        firstResponse,
        {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [
            {
              type: "text",
              text: "export function diagnosticValue() { return 6 * 7; }",
            },
          ],
          isError: false,
          timestamp: Date.now(),
        },
        secondResponse,
        {
          role: "toolResult",
          toolCallId: submitCall.id,
          toolName: submitCall.name,
          content: [{ type: "text", text: "The result was accepted." }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
      tools,
    },
    testRequestOptions(configuration),
  ).result();
  assertSuccessfulResponse(thirdResponse);
  if (
    thirdResponse.stopReason !== "stop" ||
    !thirdResponse.content.some(
      (content) => content.type === "text" && content.text.trim().length > 0,
    )
  ) {
    throw new Error(
      "The model did not finish the diagnostic workflow with a final response",
    );
  }

  return { latencyMs: Math.round(performance.now() - startedAt) };
}

/** Returns actionable copy for a model connection failure. */
export function aiConnectionErrorMessage(
  cause: unknown,
  secrets: Array<string | undefined>,
) {
  const raw = cause instanceof Error ? cause.message : "";
  const normalized = raw.toLowerCase();
  if (
    normalized.includes("items are not persisted") ||
    normalized.includes("store is set to false") ||
    (normalized.includes("item with id") && normalized.includes("not found"))
  ) {
    return "Agent tool calls require provider-side response storage for this model. Enable it under Advanced settings, then test again";
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "The provider did not respond within 30 seconds";
  }
  if (
    normalized.includes("401") ||
    normalized.includes("403") ||
    normalized.includes("unauthorized") ||
    normalized.includes("authentication") ||
    normalized.includes("api key")
  ) {
    return "Authentication failed. Check the API key or authorization headers";
  }
  if (normalized.includes("404") || normalized.includes("not found")) {
    return "The model or endpoint was not found. Check the model name and base URL";
  }
  if (normalized.includes("429") || normalized.includes("rate limit")) {
    return "The provider rate limit or quota prevented the test request";
  }

  let safe = raw.replace(/[\r\n\t]+/g, " ").trim();
  for (const secret of secrets) {
    if (secret) safe = safe.replaceAll(secret, "[redacted]");
  }
  return safe.slice(0, 300) || "Could not connect to the selected model";
}
