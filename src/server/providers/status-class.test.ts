import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  classifyProviderFailureText,
  isProviderPermissionFailure,
  reportsProviderStatusFailure,
} from "./status-class";
import { ProviderError } from "./types";

describe("classifyProviderFailure", () => {
  it("classifies live HTTP statuses and 403 subclasses", () => {
    expect(
      classifyProviderFailure(
        new ProviderError("github", "401 Unauthorized", 401),
      ),
    ).toBe("unauthorized");
    expect(
      classifyProviderFailure(
        new ProviderError("github", "403 Forbidden", 403),
      ),
    ).toBe("forbidden");
    expect(
      classifyProviderFailure(
        new ProviderError("gitlab", "403 API rate limit exceeded", 403),
      ),
    ).toBe("rate_limit");
    expect(
      classifyProviderFailure(
        new ProviderError(
          "github",
          "403 Forbidden: organization single sign-on authorization required",
          403,
        ),
      ),
    ).toBe("sso");
    expect(
      classifyProviderFailure(
        new ProviderError("github", "404 Not Found", 404),
      ),
    ).toBe("not_found");
    expect(
      classifyProviderFailure(
        new ProviderError("gitlab", "Too many requests", 429),
      ),
    ).toBe("rate_limit");
    expect(
      classifyProviderFailure(
        new ProviderError("github", "502 Bad Gateway", 502),
      ),
    ).toBe("unexpected");
    expect(
      classifyProviderFailure(new ProviderError("github", "missing status")),
    ).toBe("unexpected");
  });

  it("classifies a timeout by error name", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(classifyProviderFailure(timeout)).toBe("timeout");
  });

  it("leaves generic errors for the caller", () => {
    expect(
      classifyProviderFailure(new TypeError("fetch failed")),
    ).toBeUndefined();
    expect(
      classifyProviderFailure(
        new Error("GitHub installation token failed (403)"),
      ),
    ).toBeUndefined();
  });
});

describe("classifyProviderFailureText", () => {
  it("classifies reported statuses and authorization wording", () => {
    expect(classifyProviderFailureText("ProviderError: 401 Unauthorized")).toBe(
      "unauthorized",
    );
    expect(classifyProviderFailureText("invalid token")).toBe("unauthorized");
    expect(classifyProviderFailureText("403 Forbidden")).toBe("forbidden");
    expect(
      classifyProviderFailureText("403 Forbidden: rate limit exceeded"),
    ).toBe("rate_limit");
    expect(
      classifyProviderFailureText(
        "403 Forbidden: organization single sign-on authorization required",
      ),
    ).toBe("sso");
    expect(classifyProviderFailureText("404 Not Found")).toBe("not_found");
    expect(classifyProviderFailureText("429 Too many requests")).toBe(
      "rate_limit",
    );
    expect(classifyProviderFailureText("request timed out")).toBe("timeout");
    expect(classifyProviderFailureText("database-password=do-not-expose")).toBe(
      "unknown",
    );
  });

  it("does not read a bound-parameter placeholder as a status", () => {
    expect(
      classifyProviderFailureText(
        'Failed query: insert into "open_review_duck_review_unit" values (default, $399, $400, $401, $402)',
      ),
    ).toBe("unknown");
  });
});

describe("isProviderPermissionFailure", () => {
  it("treats 401 and 403, including SSO and 403 rate limits, as permission failures", () => {
    expect(
      isProviderPermissionFailure(
        new ProviderError("github", "Bad credentials", 401),
      ),
    ).toBe(true);
    expect(
      isProviderPermissionFailure(
        new ProviderError("github", "403 Forbidden", 403),
      ),
    ).toBe(true);
    expect(
      isProviderPermissionFailure(
        new ProviderError("github", "403 rate limit exceeded", 403),
      ),
    ).toBe(true);
    expect(
      isProviderPermissionFailure(
        new ProviderError("github", "single sign-on required", 403),
      ),
    ).toBe(true);
  });

  it("does not treat 429, 404, or timeouts as permission failures", () => {
    expect(
      isProviderPermissionFailure(
        new ProviderError("gitlab", "Too many requests", 429),
      ),
    ).toBe(false);
    expect(
      isProviderPermissionFailure(
        new ProviderError("github", "Not Found", 404),
      ),
    ).toBe(false);
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(isProviderPermissionFailure(timeout)).toBe(false);
  });
});

describe("reportsProviderStatusFailure", () => {
  it("detects status-like free text that should be classified", () => {
    expect(
      reportsProviderStatusFailure("GitHub installation token failed (403)"),
    ).toBe(true);
    expect(reportsProviderStatusFailure("fetch failed")).toBe(false);
  });
});
