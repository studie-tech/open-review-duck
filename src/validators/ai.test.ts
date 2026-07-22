import { describe, expect, it } from "vitest";
import {
  aiResultSchema,
  saveAiConfigurationSchema,
  startAiJobSchema,
  startPendingExplanationsSchema,
  testAiConfigurationSchema,
} from "./ai";

const configuration = {
  provider: "azure_openai",
  model: "gpt-5.5",
  apiProtocol: "azure-openai-responses" as const,
  apiKey: "secret",
  headers: { "X-Custom-Option": "enabled" },
  baseUrl: "https://example.openai.azure.com",
  contextWindow: 128_000,
  maxTokens: 8_000,
  storeResponses: true,
  useManagedModels: false,
  mode: "on_demand" as const,
  reviewPullRequests: true,
};

describe("AI configuration validation", () => {
  it("accepts a fully configured provider and model", () => {
    expect(saveAiConfigurationSchema.parse(configuration)).toEqual(
      configuration,
    );
  });

  it("accepts arbitrary provider identifiers with a base URL", () => {
    expect(
      saveAiConfigurationSchema.safeParse({
        ...configuration,
        provider: "my_company_gateway",
        apiProtocol: "openai-completions",
      }).success,
    ).toBe(true);
  });

  it("requires a base URL for custom providers", () => {
    expect(
      saveAiConfigurationSchema.safeParse({
        ...configuration,
        provider: "my_company_gateway",
        baseUrl: undefined,
      }).success,
    ).toBe(false);
  });

  it("rejects invalid custom header names", () => {
    expect(
      saveAiConfigurationSchema.safeParse({
        ...configuration,
        headers: { "invalid header": "value" },
      }).success,
    ).toBe(false);
  });

  it("only tests bring-your-own-model configurations", () => {
    expect(testAiConfigurationSchema.safeParse(configuration).success).toBe(
      true,
    );
    expect(
      testAiConfigurationSchema.safeParse({
        ...configuration,
        useManagedModels: true,
      }).success,
    ).toBe(false);
  });

  it("accepts a signed verification receipt when saving", () => {
    expect(
      saveAiConfigurationSchema.safeParse({
        ...configuration,
        verificationToken: "signed-receipt",
      }).success,
    ).toBe(true);
  });
});

describe("AI job validation", () => {
  const pullRequestId = "11111111-1111-4111-8111-111111111111";
  const unitId = "22222222-2222-4222-8222-222222222222";

  it("requires explanations to identify one review unit", () => {
    expect(
      startAiJobSchema.safeParse({ pullRequestId, kind: "explain" }).success,
    ).toBe(false);
    expect(
      startAiJobSchema.safeParse({ pullRequestId, unitId, kind: "explain" })
        .success,
    ).toBe(true);
  });

  it("keeps pull-request reviews unscoped", () => {
    expect(
      startAiJobSchema.safeParse({ pullRequestId, kind: "review" }).success,
    ).toBe(true);
    expect(
      startAiJobSchema.safeParse({ pullRequestId, unitId, kind: "review" })
        .success,
    ).toBe(false);
  });

  it("accepts a bounded set of units for pending explanations", () => {
    expect(
      startPendingExplanationsSchema.safeParse({
        pullRequestId,
        unitIds: [unitId],
      }).success,
    ).toBe(true);
    expect(
      startPendingExplanationsSchema.safeParse({
        pullRequestId,
        unitIds: [],
      }).success,
    ).toBe(false);
  });
});

describe("AI result validation", () => {
  it("accepts structured line-range explanations", () => {
    expect(
      aiResultSchema.parse({
        summary: "This unit maps provider failures to review-friendly copy.",
        annotations: [
          {
            title: "Normalize the provider error",
            body: "The helper turns low-level failures into stable UI text.",
            path: "src/lib/ai-errors.ts",
            line: 8,
            endLine: 15,
          },
        ],
        findings: [],
      }).annotations,
    ).toHaveLength(1);
  });

  it("defaults annotations for legacy stored results", () => {
    expect(
      aiResultSchema.parse({ summary: "Existing result", findings: [] })
        .annotations,
    ).toEqual([]);
  });
});
