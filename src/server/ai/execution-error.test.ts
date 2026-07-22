import { describe, expect, it } from "vitest";
import {
  aiExecutionErrorMessage,
  isRetryableAiExecutionError,
} from "./execution-error";

describe("aiExecutionErrorMessage", () => {
  it("keeps useful provider details while redacting credentials", () => {
    expect(
      aiExecutionErrorMessage(
        new Error(
          "Azure OpenAI API error (400): invalid response_id using secret-key",
        ),
        ["secret-key"],
      ),
    ).toBe(
      "Azure OpenAI API error (400): invalid response_id using [redacted]",
    );
  });
});

describe("isRetryableAiExecutionError", () => {
  it("does not retry deterministic provider request failures", () => {
    expect(
      isRetryableAiExecutionError(
        new Error(
          'Azure OpenAI API error (400): {"type":"invalid_request_error"}',
        ),
      ),
    ).toBe(false);
  });

  it("retries transient service and quota failures", () => {
    expect(isRetryableAiExecutionError(new TypeError("fetch failed"))).toBe(
      true,
    );
    expect(
      isRetryableAiExecutionError(new Error("Provider returned 429")),
    ).toBe(true);
    expect(
      isRetryableAiExecutionError(new Error("Provider returned 503")),
    ).toBe(true);
  });
});
