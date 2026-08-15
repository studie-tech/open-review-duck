import { describe, expect, it } from "vitest";
import { ProviderError } from "~/server/providers/types";
import {
  connectionUpdateResolvesSyncFailure,
  persistedSyncErrorMessage,
  providerSyncErrorMessage,
  reviewSyncFailureDetails,
} from "./error";

describe("resolved sync failures", () => {
  it("reads when a run failed rather than when it was queued", () => {
    const queuedAt = new Date("2026-08-05T15:00:00Z");
    const connectionUpdatedAt = new Date("2026-08-06T07:27:51Z");

    expect(
      connectionUpdateResolvesSyncFailure(
        { createdAt: queuedAt, completedAt: new Date("2026-08-05T15:03:03Z") },
        connectionUpdatedAt,
      ),
    ).toBe(true);
    // Queued before the credential was repaired and failed after it, so the
    // repair explains nothing and the failure is still the reviewer's to see.
    expect(
      connectionUpdateResolvesSyncFailure(
        { createdAt: queuedAt, completedAt: new Date("2026-08-06T07:31:12Z") },
        connectionUpdatedAt,
      ),
    ).toBe(false);
    expect(
      connectionUpdateResolvesSyncFailure(
        { createdAt: connectionUpdatedAt, completedAt: null },
        connectionUpdatedAt,
      ),
    ).toBe(false);
  });
});

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

  it("distinguishes GitHub rate-limit and SSO authorization failures", () => {
    expect(
      providerSyncErrorMessage(
        "github",
        new ProviderError("github", "403 Forbidden: rate limit exceeded", 403),
      ),
    ).toBe("GitHub rate-limited this sync. Wait a moment and try again.");
    expect(
      providerSyncErrorMessage(
        "github",
        new ProviderError(
          "github",
          "403 Forbidden: organization single sign-on authorization required",
          403,
        ),
      ),
    ).toBe(
      "GitHub requires organization SSO authorization for this token. Authorize the token with the repository's organization, then sync again.",
    );
  });

  it("names the GitHub repository permissions required for sync", () => {
    expect(
      providerSyncErrorMessage(
        "github",
        new ProviderError("github", "403 Forbidden", 403),
      ),
    ).toBe(
      "GitHub blocked access to this pull request. Confirm the token includes this repository with Contents: Read-only and Pull requests: Read and write.",
    );
  });

  it("does not expose raw network failures", () => {
    expect(
      providerSyncErrorMessage("azure_devops", new TypeError("fetch failed")),
    ).toBe(
      "ReviewDuck could not reach Azure DevOps. Check your network and provider connection, then try again.",
    );
  });

  it("classifies a failed GitHub App token mint without exposing internals", () => {
    expect(
      providerSyncErrorMessage(
        "github",
        new Error("GitHub installation token failed (403)"),
      ),
    ).toBe(
      "GitHub denied access while loading this pull request. Check that the connection includes this repository and can read its code and pull requests.",
    );
  });
});

describe("persisted sync errors", () => {
  it("turns a stored Azure DevOps 403 into permission guidance", () => {
    expect(
      persistedSyncErrorMessage(
        "azure_devops",
        "ProviderError: 403 The requested operation is not allowed. secret diagnostic details",
      ),
    ).toBe(
      "Azure DevOps denied access while loading this pull request. Reconnect a token with Code: Read & write access to this repository.",
    );
  });

  it("does not expose an unknown persisted error", () => {
    expect(
      persistedSyncErrorMessage("gitlab", "database-password=do-not-expose"),
    ).toBe(
      "GitLab synchronization failed. Check the provider connection and try again.",
    );
  });

  it("does not read a bound-parameter placeholder as a rejected credential", () => {
    // A rejected statement numbers its parameters into the hundreds, and $401
    // is the status of nothing. Reading one as a credential failure sends a
    // reviewer to reconnect a connection that is working.
    expect(
      persistedSyncErrorMessage(
        "azure_devops",
        'Failed query: insert into "open_review_duck_review_unit" values (default, $399, $400, $401, $402)',
      ),
    ).toBe(
      "Azure DevOps synchronization failed. Check the provider connection and try again.",
    );
  });

  it("still reads a status the provider actually reported", () => {
    expect(
      persistedSyncErrorMessage("github", "ProviderError: 401 Unauthorized"),
    ).toBe(
      "GitHub rejected the connected token. Reconnect the provider with a valid token.",
    );
  });
});
