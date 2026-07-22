import { describe, expect, it } from "vitest";
import {
  createAiConfigurationVerification,
  type VerifiedAiConfiguration,
  verifyAiConfiguration,
} from "./configuration-verification";

const secret = "a-secure-test-key-that-is-at-least-32-characters";
const scope = { workspaceId: "workspace-1", userId: "user-1" };
const configuration: VerifiedAiConfiguration = {
  provider: "openai",
  model: "gpt-test",
  apiProtocol: "openai-responses",
  apiKey: "provider-secret",
  headers: { "x-second": "2", "x-first": "1" },
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 128_000,
  maxTokens: 8_000,
  storeResponses: false,
};

describe("AI configuration verification", () => {
  it("accepts the exact tested configuration within the validity window", () => {
    const token = createAiConfigurationVerification(
      configuration,
      scope,
      secret,
      1_000,
    );

    expect(
      verifyAiConfiguration(token, configuration, scope, secret, 2_000),
    ).toBe(true);
  });

  it("is stable when header insertion order changes", () => {
    const token = createAiConfigurationVerification(
      configuration,
      scope,
      secret,
      1_000,
    );

    expect(
      verifyAiConfiguration(
        token,
        { ...configuration, headers: { "x-first": "1", "x-second": "2" } },
        scope,
        secret,
        2_000,
      ),
    ).toBe(true);
  });

  it("rejects changed credentials, model settings, scope, and signatures", () => {
    const token = createAiConfigurationVerification(
      configuration,
      scope,
      secret,
      1_000,
    );

    expect(
      verifyAiConfiguration(
        token,
        { ...configuration, apiKey: "different" },
        scope,
        secret,
        2_000,
      ),
    ).toBe(false);
    expect(
      verifyAiConfiguration(
        token,
        { ...configuration, model: "another-model" },
        scope,
        secret,
        2_000,
      ),
    ).toBe(false);
    expect(
      verifyAiConfiguration(
        token,
        configuration,
        { ...scope, userId: "another-user" },
        secret,
        2_000,
      ),
    ).toBe(false);
    expect(
      verifyAiConfiguration(`${token}tampered`, configuration, scope, secret),
    ).toBe(false);
  });

  it("rejects expired receipts", () => {
    const token = createAiConfigurationVerification(
      configuration,
      scope,
      secret,
      1_000,
    );

    expect(
      verifyAiConfiguration(
        token,
        configuration,
        scope,
        secret,
        1_000 + 10 * 60 * 1_000 + 1,
      ),
    ).toBe(false);
  });
});
