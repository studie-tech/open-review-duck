import { describe, expect, it } from "vitest";
import {
  classifyReviewItemError,
  coveragePartitionErrors,
  type DeepReviewItemState,
  deepReviewTerminalState,
} from "./coverage";

/** Builds coverage items from a compact list of states. */
function items(...states: DeepReviewItemState[]) {
  return states.map((state, index) => ({
    state,
    path: `src/file-${index}.ts`,
  }));
}

describe("deepReviewTerminalState", () => {
  it("reports a run that selected nothing as skipped", () => {
    expect(deepReviewTerminalState([])).toBe("skipped");
  });

  it("reports every covered combination as complete", () => {
    expect(deepReviewTerminalState(items("completed"))).toBe("complete");
    expect(deepReviewTerminalState(items("reused"))).toBe("complete");
    expect(deepReviewTerminalState(items("waived"))).toBe("complete");
    expect(
      deepReviewTerminalState(items("completed", "reused", "waived")),
    ).toBe("complete");
  });

  it("reports failed only when every item failed", () => {
    expect(deepReviewTerminalState(items("failed"))).toBe("failed");
    expect(deepReviewTerminalState(items("failed", "failed"))).toBe("failed");
  });

  it("reports partial when some but not all items failed", () => {
    expect(deepReviewTerminalState(items("failed", "completed"))).toBe(
      "partial",
    );
    expect(deepReviewTerminalState(items("completed", "failed"))).toBe(
      "partial",
    );
    expect(deepReviewTerminalState(items("failed", "failed", "reused"))).toBe(
      "partial",
    );
  });

  it("counts a waived file as covered rather than failed", () => {
    // The all-failed boundary: one waived file keeps the run out of `failed`.
    expect(deepReviewTerminalState(items("failed", "waived"))).toBe("partial");
    expect(deepReviewTerminalState(items("waived", "waived"))).toBe("complete");
  });

  it("counts a reused file as covered rather than failed", () => {
    expect(deepReviewTerminalState(items("failed", "reused"))).toBe("partial");
  });

  it("rejects a lingering selected item as a finalize bug", () => {
    expect(() => deepReviewTerminalState(items("selected"))).toThrow(
      /selected/,
    );
    expect(() =>
      deepReviewTerminalState(items("completed", "selected")),
    ).toThrow(/selected/);
    expect(() => deepReviewTerminalState(items("failed", "selected"))).toThrow(
      /selected/,
    );
  });
});

describe("coveragePartitionErrors", () => {
  it("accepts a coverage set that partitions the sealed plan", () => {
    expect(
      coveragePartitionErrors({
        selectedCount: 3,
        items: items("completed", "failed", "waived"),
      }),
    ).toEqual([]);
  });

  it("accepts an empty plan with a zero denominator", () => {
    expect(coveragePartitionErrors({ selectedCount: 0, items: [] })).toEqual(
      [],
    );
  });

  it("reports a denominator that does not match the item count", () => {
    const errors = coveragePartitionErrors({
      selectedCount: 4,
      items: items("completed", "completed"),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("2 item(s)");
    expect(errors[0]).toContain("4");
  });

  it("reports a denominator that is not a non-negative integer", () => {
    expect(coveragePartitionErrors({ selectedCount: -1, items: [] })).toEqual([
      "sealed denominator -1 is not a non-negative integer",
    ]);
    expect(
      coveragePartitionErrors({ selectedCount: 1.5, items: items("waived") }),
    ).toEqual(["sealed denominator 1.5 is not a non-negative integer"]);
  });

  it("names every item still in the selected state", () => {
    const errors = coveragePartitionErrors({
      selectedCount: 3,
      items: items("completed", "selected", "selected"),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("2 item(s)");
    expect(errors[0]).toContain("src/file-1.ts");
    expect(errors[0]).toContain("src/file-2.ts");
  });

  it("falls back to a positional label when an item has no path", () => {
    const errors = coveragePartitionErrors({
      selectedCount: 1,
      items: [{ state: "selected" }],
    });
    expect(errors).toEqual(['1 item(s) never left state "selected": #0']);
  });

  it("reports duplicate paths carried by the items", () => {
    expect(
      coveragePartitionErrors({
        selectedCount: 3,
        items: [
          { state: "completed", path: "src/a.ts" },
          { state: "completed", path: "src/b.ts" },
          { state: "failed", path: "src/a.ts" },
        ],
      }),
    ).toEqual(["path is covered by more than one item: src/a.ts"]);
  });

  it("reports duplicates from explicitly supplied paths", () => {
    expect(
      coveragePartitionErrors({
        selectedCount: 2,
        items: [{ state: "completed" }, { state: "completed" }],
        paths: ["src/a.ts", "src/a.ts"],
      }),
    ).toEqual(["path is covered by more than one item: src/a.ts"]);
  });

  it("reports a supplied path list that does not cover every item", () => {
    const errors = coveragePartitionErrors({
      selectedCount: 2,
      items: [{ state: "completed" }, { state: "completed" }],
      paths: ["src/a.ts"],
    });
    expect(errors).toEqual([
      "path list holds 1 entry/entries but coverage holds 2 item(s)",
    ]);
  });

  it("reports one duplicate line per repeated path", () => {
    const errors = coveragePartitionErrors({
      selectedCount: 4,
      items: [
        { state: "completed", path: "src/a.ts" },
        { state: "completed", path: "src/a.ts" },
        { state: "completed", path: "src/b.ts" },
        { state: "completed", path: "src/b.ts" },
      ],
    });
    expect(errors).toEqual([
      "path is covered by more than one item: src/a.ts",
      "path is covered by more than one item: src/b.ts",
    ]);
  });

  it("reports every independent violation at once", () => {
    const errors = coveragePartitionErrors({
      selectedCount: 4,
      items: [
        { state: "selected", path: "src/a.ts" },
        { state: "completed", path: "src/a.ts" },
      ],
    });
    expect(errors).toHaveLength(3);
  });

  it("ignores items without a path when looking for duplicates", () => {
    expect(
      coveragePartitionErrors({
        selectedCount: 2,
        items: [{ state: "completed" }, { state: "waived" }],
      }),
    ).toEqual([]);
  });
});

describe("classifyReviewItemError", () => {
  it("classifies explicit timeouts", () => {
    expect(classifyReviewItemError(new Error("request timed out"))).toBe(
      "timeout",
    );
    expect(classifyReviewItemError(new Error("Timeout of 30000ms"))).toBe(
      "timeout",
    );
    expect(classifyReviewItemError({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(classifyReviewItemError("connect ETIMEDOUT 10.0.0.1:443")).toBe(
      "timeout",
    );
  });

  it("classifies an AbortError as a timeout", () => {
    const error = new Error("This operation was aborted");
    error.name = "AbortError";
    expect(classifyReviewItemError(error)).toBe("timeout");
  });

  it("classifies an abort caused by a timeout as a timeout", () => {
    const error = new Error("The operation was aborted due to timeout");
    expect(classifyReviewItemError(error)).toBe("timeout");
    expect(
      classifyReviewItemError(
        new Error("aborted", { cause: new Error("HeadersTimeoutError") }),
      ),
    ).toBe("timeout");
  });

  it("classifies an abort with no timeout evidence as cancellation", () => {
    expect(classifyReviewItemError(new Error("aborted"))).toBe("cancelled");
    expect(classifyReviewItemError(new Error("Job was cancelled"))).toBe(
      "cancelled",
    );
    expect(classifyReviewItemError("review canceled by user")).toBe(
      "cancelled",
    );
  });

  it("prefers explicit cancellation wording over the AbortError name", () => {
    const error = new Error("the user cancelled this review");
    error.name = "AbortError";
    expect(classifyReviewItemError(error)).toBe("cancelled");
  });

  it("classifies provider faults", () => {
    expect(classifyReviewItemError(new TypeError("fetch failed"))).toBe(
      "provider",
    );
    expect(classifyReviewItemError({ status: 503 })).toBe("provider");
    expect(classifyReviewItemError({ statusCode: 404 })).toBe("provider");
    expect(
      classifyReviewItemError(new Error("Request failed with status code 500")),
    ).toBe("provider");
    expect(classifyReviewItemError(new Error("provider_failure"))).toBe(
      "provider",
    );
    expect(classifyReviewItemError({ code: "ECONNRESET" })).toBe("provider");
  });

  it("classifies rate limiting as a provider fault, not a budget stop", () => {
    expect(
      classifyReviewItemError({
        status: 429,
        message: "rate limit exceeded, quota resets in 60s",
      }),
    ).toBe("provider");
    expect(classifyReviewItemError(new Error("429 Too Many Requests"))).toBe(
      "provider",
    );
  });

  it("classifies budget stops", () => {
    expect(classifyReviewItemError(new Error("monthly quota exhausted"))).toBe(
      "budget",
    );
    expect(classifyReviewItemError(new Error("workspace budget reached"))).toBe(
      "budget",
    );
    expect(classifyReviewItemError(new Error("token limit exceeded"))).toBe(
      "budget",
    );
    expect(classifyReviewItemError("cost_limit")).toBe("budget");
  });

  it("classifies investigation and tool ceilings", () => {
    expect(classifyReviewItemError(new Error("tool call limit reached"))).toBe(
      "tool_limit",
    );
    expect(classifyReviewItemError("investigation_limit")).toBe("tool_limit");
  });

  it("classifies anything unrecognized as unknown", () => {
    expect(classifyReviewItemError(new Error("boom"))).toBe("unknown");
    expect(classifyReviewItemError(undefined)).toBe("unknown");
    expect(classifyReviewItemError(null)).toBe("unknown");
    expect(classifyReviewItemError({})).toBe("unknown");
    expect(classifyReviewItemError(42)).toBe("unknown");
  });

  it("reads evidence from a nested cause chain", () => {
    const inner = new Error("connect ECONNREFUSED");
    const outer = new Error("file review failed", { cause: inner });
    expect(classifyReviewItemError(outer)).toBe("provider");
    expect(
      classifyReviewItemError({
        message: "wrapped",
        response: { status: 502 },
      }),
    ).toBe("provider");
  });

  it("reads evidence from an aggregate error", () => {
    expect(
      classifyReviewItemError(
        new AggregateError([new Error("nope"), new Error("timed out")]),
      ),
    ).toBe("timeout");
  });

  it("survives a self-referential cause chain", () => {
    const error = new Error("boom") as Error & { cause?: unknown };
    error.cause = error;
    expect(classifyReviewItemError(error)).toBe("unknown");
  });
  it("classifies a transport failure to the provider as provider", () => {
    expect(
      classifyReviewItemError(
        new Error(
          "8021E6EE01000000:error:0A0003FC:SSL routines:ssl3_read_bytes:ssl/tls alert bad record mac",
        ),
      ),
    ).toBe("provider");
    expect(classifyReviewItemError(new Error("write EPIPE"))).toBe("provider");
    expect(classifyReviewItemError(new Error("getaddrinfo ENOTFOUND"))).toBe(
      "provider",
    );
  });
});
