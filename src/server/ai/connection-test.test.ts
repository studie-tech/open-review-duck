import type {
  AssistantMessage,
  Context,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { VerifiedAiConfiguration } from "./configuration-verification";
import {
  aiConnectionErrorMessage,
  testAiProviderConnection,
} from "./connection-test";

const configuration: VerifiedAiConfiguration = {
  provider: "azure",
  model: "gpt-test",
  apiProtocol: "azure-openai-responses",
  apiKey: "provider-key",
  headers: {},
  baseUrl: "https://example.openai.azure.com/openai/v1",
  contextWindow: 128_000,
  maxTokens: 8_000,
  storeResponses: true,
};

/** Creates a minimal assistant response for model connection tests. */
function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "azure-openai-responses",
    provider: "azure",
    model: "gpt-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

describe("AI connection error presentation", () => {
  it("turns common provider failures into actionable messages", () => {
    expect(aiConnectionErrorMessage(new Error("HTTP 401"), [])).toContain(
      "Authentication failed",
    );
    expect(aiConnectionErrorMessage(new Error("HTTP 404"), [])).toContain(
      "model or endpoint",
    );
    expect(aiConnectionErrorMessage(new Error("request timed out"), [])).toBe(
      "The provider did not respond within 30 seconds",
    );
    expect(
      aiConnectionErrorMessage(
        new Error(
          "Item with id rs_123 not found. Items are not persisted when store is set to false.",
        ),
        [],
      ),
    ).toContain("Enable it under Advanced settings");
  });

  it("redacts credentials from unexpected provider messages", () => {
    expect(
      aiConnectionErrorMessage(
        new Error("Provider echoed secret-value in its response"),
        ["secret-value"],
      ),
    ).toBe("Provider echoed [redacted] in its response");
  });

  it("tests a tool call and its follow-up using the configured storage mode", async () => {
    const firstResponse = assistant(
      [
        {
          type: "toolCall",
          id: "call-1",
          name: "read_reviewduck_diagnostic",
          arguments: {},
        },
      ],
      "toolUse",
    );
    const secondResponse = assistant(
      [
        {
          type: "toolCall",
          id: "call-2",
          name: "submit_reviewduck_diagnostic",
          arguments: { answer: 42 },
        },
      ],
      "toolUse",
    );
    const thirdResponse = assistant([{ type: "text", text: "OK" }], "stop");
    const request = vi
      .fn()
      .mockReturnValueOnce({ result: async () => firstResponse })
      .mockReturnValueOnce({ result: async () => secondResponse })
      .mockReturnValueOnce({ result: async () => thirdResponse });

    await testAiProviderConnection(configuration, request);

    expect(request).toHaveBeenCalledTimes(3);
    const thirdContext = request.mock.calls[2]?.[1] as Context;
    expect(thirdContext.messages.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
    ]);
    const options = request.mock.calls[0]?.[2] as SimpleStreamOptions;
    expect(await options.onPayload?.({ store: false }, {} as never)).toEqual({
      store: true,
    });
  });
});
