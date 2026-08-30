import { describe, expect, it } from "vitest";
import {
  buildProviderLifecycle,
  followPendingProviderLifecycle,
  providerCheckStateLabel,
  providerCheckSummary,
  providerLifecycleSummaryLabel,
} from "./provider-lifecycle";

describe("providerCheckSummary", () => {
  it("treats failures as blocking and cancelled checks as non-blocking", () => {
    expect(providerCheckSummary([])).toBe("empty");
    expect(
      providerCheckSummary([{ state: "success" }, { state: "in_progress" }]),
    ).toBe("pending");
    expect(
      providerCheckSummary([
        { state: "success" },
        { state: "failure" },
        { state: "queued" },
      ]),
    ).toBe("failing");
    expect(
      providerCheckSummary([
        { state: "success" },
        { state: "cancelled" },
        { state: "skipped" },
        { state: "neutral" },
      ]),
    ).toBe("passing");
  });
});

describe("provider lifecycle labels", () => {
  it("names check states and summarizes the completion-page badge", () => {
    expect(providerCheckStateLabel("in_progress")).toBe("Running");
    expect(providerCheckStateLabel("failure")).toBe("Failed");
    expect(providerLifecycleSummaryLabel("empty", 0)).toBe(
      "No checks reported",
    );
    expect(providerLifecycleSummaryLabel("passing", 3)).toBe(
      "All checks passed",
    );
    expect(providerLifecycleSummaryLabel("failing", 1)).toBe("1 check failed");
    expect(providerLifecycleSummaryLabel("pending", 2)).toBe("Checks running");
  });
});

describe("buildProviderLifecycle", () => {
  it("attaches the derived check summary to the merge payload", () => {
    expect(
      buildProviderLifecycle({
        checks: [{ id: "ci", name: "CI", state: "success" }],
        pullRequestState: "open",
        headSha: "abc1234",
        mergeable: true,
        canMerge: true,
        mergeActionLabel: "Merge",
      }).summary,
    ).toBe("passing");
  });
});

describe("followPendingProviderLifecycle", () => {
  it("polls only while checks or mergeability are still settling", () => {
    expect(followPendingProviderLifecycle({ state: {} })).toBe(false);
    expect(
      followPendingProviderLifecycle({
        state: { data: { summary: "passing", mergeable: true } },
      }),
    ).toBe(false);
    expect(
      followPendingProviderLifecycle({
        state: { data: { summary: "pending", mergeable: true } },
      }),
    ).toBe(8_000);
    expect(
      followPendingProviderLifecycle({
        state: {
          data: {
            summary: "passing",
            mergeable: null,
            pullRequestState: "open",
          },
        },
      }),
    ).toBe(8_000);
  });
});
