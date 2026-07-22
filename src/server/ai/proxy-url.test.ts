import { describe, expect, it } from "vitest";
import { providerProxyTarget } from "./proxy-url";

describe("providerProxyTarget", () => {
  it("does not duplicate an endpoint already present in the configured URL", () => {
    expect(
      providerProxyTarget(
        "https://resource.services.ai.azure.com/openai/v1/responses",
        ["responses"],
      ).toString(),
    ).toBe("https://resource.services.ai.azure.com/openai/v1/responses");
  });

  it("appends a missing endpoint to an API root", () => {
    expect(
      providerProxyTarget("https://resource.services.ai.azure.com/openai/v1", [
        "responses",
      ]).toString(),
    ).toBe("https://resource.services.ai.azure.com/openai/v1/responses");
  });

  it("retains the overlap when an SDK addresses a nested endpoint", () => {
    expect(
      providerProxyTarget("https://provider.example/v1/responses", [
        "responses",
        "response_123",
      ]).toString(),
    ).toBe("https://provider.example/v1/responses/response_123");
  });

  it("preserves configured query parameters and encodes new path segments", () => {
    expect(
      providerProxyTarget("https://provider.example/custom?api-version=v1", [
        "models",
        "model name",
      ]).toString(),
    ).toBe(
      "https://provider.example/custom/models/model%20name?api-version=v1",
    );
  });
});
