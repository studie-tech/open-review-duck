import { describe, expect, it } from "vitest";

import { redactSentryEvent, tracesSampler } from "./sentry-safety";

describe("Sentry telemetry safety", () => {
  it("redacts the same sensitive fields in browser, edge, and server events", () => {
    expect(
      redactSentryEvent({
        message: "provider request failed",
        context: {
          repositoryPath: "private/repository/file.ts",
          sourceCode: "const secret = true",
          modelOutput: "private answer",
          signedUrl: "https://objects.example/private",
        },
      }),
    ).toEqual({
      message: "provider request failed",
      context: {
        repositoryPath: "[REDACTED]",
        sourceCode: "[REDACTED]",
        modelOutput: "[REDACTED]",
        signedUrl: "[REDACTED]",
      },
    });
  });

  it("preserves nullish values and harmless telemetry", () => {
    expect(redactSentryEvent(null)).toBeNull();
    expect(redactSentryEvent(undefined)).toBeUndefined();
    expect(redactSentryEvent({ status: "failed", durationMs: 42 })).toEqual({
      status: "failed",
      durationMs: 42,
    });
  });

  it("keeps the intended trace budgets", () => {
    expect(tracesSampler({ name: "GET /health" })).toBe(0);
    expect(tracesSampler({ name: "sync pull request" })).toBe(0.1);
    expect(tracesSampler({ name: "GET /dashboard" })).toBe(0.01);
  });
});
