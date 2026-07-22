import { describe, expect, it } from "vitest";
import { ProviderError } from "~/server/providers/types";
import { providerSyncErrorMessage, reviewSyncFailureDetails } from "./error";

describe("review sync error diagnostics", () => {
  it("reports the bounded database cause without the failed query", () => {
    const databaseError = Object.assign(
      new Error("duplicate key value violates unique constraint"),
      {
        code: "23505",
        constraint: "review_unit_dependency_pkey",
      },
    );
    const queryError = new Error(`Failed query: ${"x".repeat(1_000)}`, {
      cause: databaseError,
    });

    expect(reviewSyncFailureDetails(queryError)).toEqual({
      name: "Error",
      message: "duplicate key value violates unique constraint",
      code: "23505",
      constraint: "review_unit_dependency_pkey",
    });
  });
});

describe("provider sync errors", () => {
  it("explains a rejected provider token", () => {
    expect(
      providerSyncErrorMessage(
        "github",
        new ProviderError("github", "401 Unauthorized", 401),
      ),
    ).toBe(
      "GitHub rejected the connected token. Reconnect the provider with a valid token.",
    );
  });

  it("distinguishes provider rate limits", () => {
    expect(
      providerSyncErrorMessage(
        "gitlab",
        new ProviderError("gitlab", "Too many requests", 429),
      ),
    ).toBe("GitLab rate-limited this sync. Wait a moment and try again.");
  });

  it("does not expose raw network failures", () => {
    expect(
      providerSyncErrorMessage("azure_devops", new TypeError("fetch failed")),
    ).toBe(
      "ReviewDuck could not reach Azure DevOps. Check your network and provider connection, then try again.",
    );
  });
});
