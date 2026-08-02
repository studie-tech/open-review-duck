import { describe, expect, it } from "vitest";
import { providerConnectionErrorMessage } from "./connection-error";
import { ProviderError } from "./types";

describe("providerConnectionErrorMessage", () => {
  it("explains rejected GitHub tokens", () => {
    expect(
      providerConnectionErrorMessage(
        "github",
        new ProviderError("github", "401 Unauthorized", 401),
      ),
    ).toBe(
      "GitHub rejected this token. Create a new token, copy the complete value, and try again.",
    );
  });

  it("names the missing GitHub permissions when access is blocked", () => {
    expect(
      providerConnectionErrorMessage(
        "github",
        new ProviderError("github", "403 Forbidden", 403),
      ),
    ).toContain("Contents: Read-only and Pull requests: Read and write");
  });

  it("distinguishes rate limits from missing permissions", () => {
    expect(
      providerConnectionErrorMessage(
        "gitlab",
        new ProviderError("gitlab", "403 API rate limit exceeded", 403),
      ),
    ).toBe(
      "GitLab's API rate limit is exhausted. Wait for GitLab to reset it before retrying; repeated retries will not help.",
    );
  });

  it("explains GitHub Enterprise URL failures", () => {
    expect(
      providerConnectionErrorMessage(
        "github",
        new ProviderError("github", "404 Not Found", 404),
      ),
    ).toContain("leave it empty for github.com");
  });
});
