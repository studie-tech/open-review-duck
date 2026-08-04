import { describe, expect, it } from "vitest";

import {
  redactSentryEvent,
  sentryIngestOrigin,
  tracesSampler,
} from "./sentry-safety";

describe("Sentry telemetry safety", () => {
  it("allows only the configured HTTPS ingest origin", () => {
    expect(
      sentryIngestOrigin("https://public@example.ingest.sentry.io/123"),
    ).toBe("https://example.ingest.sentry.io");
    expect(sentryIngestOrigin("http://example.test/123")).toBeUndefined();
    expect(sentryIngestOrigin("not a DSN")).toBeUndefined();
  });

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

  it("removes callback query credentials and route request data", () => {
    expect(
      redactSentryEvent({
        request: {
          url: "https://reviewduck.example/api/integrations/github/callback?code=secret&state=signed",
          data: { harmless: "still sensitive in this route" },
          method: "GET",
        },
        breadcrumb: {
          url: "/api/webhooks/gitlab?hook=opaque",
          body: "private provider payload",
        },
        span: {
          "http.url":
            "https://reviewduck.example/api/integrations/gitlab/callback?code=secret",
          "url.query": "code=secret",
        },
        publicCallback: {
          url: "https://reviewduck.example/gitlab/complete?code=secret&state=signed",
          query: "code=secret&state=signed",
        },
      }),
    ).toEqual({
      request: {
        url: "https://reviewduck.example/api/integrations/github/callback",
        data: "[REDACTED]",
        method: "GET",
      },
      breadcrumb: {
        url: "/api/webhooks/gitlab",
        body: "[REDACTED]",
      },
      span: {
        "http.url":
          "https://reviewduck.example/api/integrations/gitlab/callback",
        "url.query": "[REDACTED]",
      },
      publicCallback: {
        url: "https://reviewduck.example/gitlab/complete",
        query: "[REDACTED]",
      },
    });
  });

  it("keeps the intended trace budgets", () => {
    expect(tracesSampler({ name: "GET /health" })).toBe(0);
    expect(tracesSampler({ name: "sync pull request" })).toBe(0.1);
    expect(tracesSampler({ name: "GET /gitlab/complete" })).toBe(0.1);
    expect(tracesSampler({ name: "GET /dashboard" })).toBe(0.01);
  });
});
