import { describe, expect, it } from "vitest";
import {
  deepReviewFindingId,
  type FindingSeverity,
  findingSeverityRank,
  normalizeFindingCategory,
  normalizeFindingSeverity,
  normalizeSnippet,
  orderFindings,
} from "./findings";

describe("normalizeFindingSeverity", () => {
  it("keeps every declared severity", () => {
    expect(normalizeFindingSeverity("critical")).toBe("critical");
    expect(normalizeFindingSeverity("high")).toBe("high");
    expect(normalizeFindingSeverity("medium")).toBe("medium");
    expect(normalizeFindingSeverity("low")).toBe("low");
  });

  it("lowercases and trims what the model actually sends", () => {
    expect(normalizeFindingSeverity("CRITICAL")).toBe("critical");
    expect(normalizeFindingSeverity("  High  ")).toBe("high");
  });

  it("degrades an invented severity to low instead of rejecting it", () => {
    expect(normalizeFindingSeverity("blocker")).toBe("low");
    expect(normalizeFindingSeverity("info")).toBe("low");
    expect(normalizeFindingSeverity("")).toBe("low");
  });

  it("degrades a non-string severity to low", () => {
    expect(normalizeFindingSeverity(undefined)).toBe("low");
    expect(normalizeFindingSeverity(null)).toBe("low");
    expect(normalizeFindingSeverity(3)).toBe("low");
    expect(normalizeFindingSeverity({ severity: "critical" })).toBe("low");
  });
});

describe("normalizeFindingCategory", () => {
  it("keeps every declared category", () => {
    for (const category of [
      "bug",
      "security",
      "performance",
      "maintainability",
      "test",
      "style",
      "documentation",
      "other",
    ] as const) {
      expect(normalizeFindingCategory(category)).toBe(category);
    }
  });

  it("lowercases and trims what the model actually sends", () => {
    expect(normalizeFindingCategory("SECURITY")).toBe("security");
    expect(normalizeFindingCategory(" Maintainability ")).toBe(
      "maintainability",
    );
  });

  it("degrades an unrecognized category to other instead of rejecting it", () => {
    expect(normalizeFindingCategory("vulnerability")).toBe("other");
    expect(normalizeFindingCategory("correctness")).toBe("other");
    expect(normalizeFindingCategory("")).toBe("other");
  });

  it("degrades a non-string category to other", () => {
    expect(normalizeFindingCategory(undefined)).toBe("other");
    expect(normalizeFindingCategory(["bug"])).toBe("other");
  });
});

describe("findingSeverityRank", () => {
  it("ranks critical worst and low least", () => {
    expect(findingSeverityRank("critical")).toBe(0);
    expect(findingSeverityRank("high")).toBe(1);
    expect(findingSeverityRank("medium")).toBe(2);
    expect(findingSeverityRank("low")).toBe(3);
  });

  it("sorts a shuffled severity list worst first", () => {
    const severities: FindingSeverity[] = ["low", "critical", "medium", "high"];
    expect(
      [...severities].sort(
        (left, right) => findingSeverityRank(left) - findingSeverityRank(right),
      ),
    ).toEqual(["critical", "high", "medium", "low"]);
  });
});

describe("normalizeSnippet", () => {
  it("strips diff markers and indentation from a reported excerpt", () => {
    const reported = [
      "+  const token = req.query.token;",
      "",
      "-  if (!token) return null;",
      "   return verify(token);",
      "   ",
    ].join("\n");
    expect(normalizeSnippet(reported)).toBe(
      [
        "const token = req.query.token;",
        "if (!token) return null;",
        "return verify(token);",
      ].join("\n"),
    );
  });

  it("drops blank and marker-only lines", () => {
    expect(normalizeSnippet("+\n\n-\n  \nreturn 1;")).toBe("return 1;");
  });

  it("strips only one leading marker so nested signs survive", () => {
    expect(normalizeSnippet("+  return -1;")).toBe("return -1;");
    expect(normalizeSnippet("-+value")).toBe("+value");
  });

  it("tolerates carriage returns from a Windows checkout", () => {
    expect(normalizeSnippet("+  a();\r\n\r\n   b();\r")).toBe("a();\nb();");
  });

  it("returns an empty string for content with nothing left", () => {
    expect(normalizeSnippet("")).toBe("");
    expect(normalizeSnippet("\n  \n\n")).toBe("");
  });

  it("agrees between a diff-marked excerpt and the plain file text", () => {
    const excerpt = "+    doWork();\n+    doMore();";
    const fileText = "    doWork();\n    doMore();\n";
    expect(normalizeSnippet(excerpt)).toBe(normalizeSnippet(fileText));
  });
});

describe("deepReviewFindingId", () => {
  it("returns the same id for the same call and index", () => {
    const input = { toolCallId: "call_abc123", index: 0 };
    expect(deepReviewFindingId(input)).toBe(deepReviewFindingId(input));
  });

  it("returns a 32 character hex id", () => {
    const id = deepReviewFindingId({ toolCallId: "call_abc123", index: 2 });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("separates two findings reported by the same call", () => {
    const first = deepReviewFindingId({ toolCallId: "call_abc123", index: 0 });
    const second = deepReviewFindingId({ toolCallId: "call_abc123", index: 1 });
    expect(first).not.toBe(second);
  });

  it("separates identical indexes across different calls", () => {
    expect(deepReviewFindingId({ toolCallId: "call_a", index: 0 })).not.toBe(
      deepReviewFindingId({ toolCallId: "call_b", index: 0 }),
    );
  });

  it("does not collide when a call id and index run together", () => {
    expect(deepReviewFindingId({ toolCallId: "call_1", index: 11 })).not.toBe(
      deepReviewFindingId({ toolCallId: "call_11", index: 1 }),
    );
  });

  it("keeps a whole batch of ids distinct", () => {
    const ids = new Set<string>();
    for (const toolCallId of ["call_a", "call_b", "call_c"]) {
      for (let index = 0; index < 24; index += 1) {
        ids.add(deepReviewFindingId({ toolCallId, index }));
      }
    }
    expect(ids.size).toBe(72);
  });
});

interface TestFinding {
  id: string;
  severity: FindingSeverity;
  path: string | null;
  startLine: number | null;
  title: string;
}

/** Builds an orderable finding carrying a field `orderFindings` must preserve. */
const finding = (
  id: string,
  severity: FindingSeverity,
  path: string | null,
  startLine: number | null,
): TestFinding => ({ id, severity, path, startLine, title: `title-${id}` });

describe("orderFindings", () => {
  it("surfaces the worst severity first", () => {
    const ordered = orderFindings([
      finding("a", "low", "src/a.ts", 1),
      finding("b", "critical", "src/z.ts", 900),
      finding("c", "medium", "src/m.ts", 5),
      finding("d", "high", "src/m.ts", 5),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("breaks severity ties by path, then start line, then id", () => {
    const ordered = orderFindings([
      finding("c", "high", "src/b.ts", 10),
      finding("b", "high", "src/a.ts", 40),
      finding("d", "high", "src/a.ts", 12),
      finding("a", "high", "src/a.ts", 12),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["a", "d", "b", "c"]);
  });

  it("places findings without a path or line last within their severity", () => {
    const ordered = orderFindings([
      finding("a", "high", null, null),
      finding("b", "high", "src/a.ts", null),
      finding("c", "high", "src/a.ts", 3),
      finding("d", "critical", null, null),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["d", "c", "b", "a"]);
  });

  it("orders identical input identically regardless of arrival order", () => {
    const a = finding("a", "medium", "src/a.ts", 4);
    const b = finding("b", "medium", "src/a.ts", 4);
    const c = finding("c", "critical", null, 9);
    const d = finding("d", "low", "src/b.ts", null);
    const e = finding("e", "medium", null, 1);
    const expected = orderFindings([a, b, c, d, e]).map((item) => item.id);
    expect(expected).toEqual(["c", "a", "b", "e", "d"]);
    expect(orderFindings([e, d, c, b, a]).map((item) => item.id)).toEqual(
      expected,
    );
    expect(orderFindings([c, e, a, d, b]).map((item) => item.id)).toEqual(
      expected,
    );
  });

  it("returns a new array and leaves the input untouched", () => {
    const findings = [
      finding("a", "low", "src/a.ts", 1),
      finding("b", "critical", "src/a.ts", 2),
    ];
    const ordered = orderFindings(findings);
    expect(ordered).not.toBe(findings);
    expect(findings.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("preserves the caller's own finding fields", () => {
    const [first] = orderFindings([finding("a", "high", "src/a.ts", 7)]);
    expect(first?.title).toBe("title-a");
  });

  it("returns an empty array unchanged in content", () => {
    expect(orderFindings([])).toEqual([]);
  });
});
