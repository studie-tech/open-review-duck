import { describe, expect, it } from "vitest";
import {
  isMovedCodeLine,
  type MovedCodeFile,
  movedCodeRanges,
} from "./moved-code";

const shipping = [
  "export function shippingCost(subtotal: number) {",
  "  if (subtotal >= 50) return 0;",
  "  return 5;",
  "}",
].join("\n");

/** Builds a removed source and an inserted destination for movement comparisons. */
function extraction(currentSource = shipping): MovedCodeFile[] {
  return [
    { path: "checkout.ts", previousSource: shipping, currentSource: "" },
    { path: "shipping.ts", previousSource: "", currentSource },
  ];
}

describe("movedCodeRanges", () => {
  it("matches an unchanged extraction on both sides across files", () => {
    expect(movedCodeRanges(extraction())).toEqual([
      {
        path: "checkout.ts",
        previous: [{ startLine: 1, endLine: 4 }],
        current: [],
      },
      {
        path: "shipping.ts",
        previous: [],
        current: [{ startLine: 1, endLine: 4 }],
      },
    ]);
  });

  it("keeps edits inside a move colored and excludes new imports", () => {
    const result = movedCodeRanges(
      extraction(
        `import { Item } from "./types";\n\n${shipping.replace("50", "75")}`,
      ),
    );
    expect(result[0]?.previous).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 4 },
    ]);
    expect(result[1]?.current).toEqual([
      { startLine: 3, endLine: 3 },
      { startLine: 5, endLine: 6 },
    ]);
    expect(isMovedCodeLine(result[1]?.current, 4)).toBe(false);
  });

  it("matches multiple extracted blocks independently from one deletion", () => {
    const subtotal =
      "export function subtotal(items: Item[]) {\n  return items.reduce((sum, item) =>\n    sum + item.price * item.quantity, 0);\n}";
    const result = movedCodeRanges([
      {
        path: "checkout.ts",
        previousSource: `${shipping}\n${subtotal}`,
        currentSource: "",
      },
      {
        path: "shipping.ts",
        previousSource: "",
        currentSource: shipping.replace("50", "75"),
      },
      { path: "subtotal.ts", previousSource: "", currentSource: subtotal },
    ]);
    expect(result.find((file) => file.path === "subtotal.ts")?.current).toEqual(
      [{ startLine: 1, endLine: 4 }],
    );
    expect(isMovedCodeLine(result[0]?.previous, 2)).toBe(false);
    expect(isMovedCodeLine(result[0]?.previous, 5)).toBe(true);
  });

  it("detects reordered blocks within a file", () => {
    const other =
      "export function tax(total: number) {\n  return total * 0.2;\n}";
    const result = movedCodeRanges([
      {
        path: "pricing.ts",
        previousSource: `${shipping}\n\n${other}`,
        currentSource: `${other}\n\n${shipping.replace("50", "75")}`,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.previous.length).toBeGreaterThan(0);
    expect(result[0]?.current.length).toBeGreaterThan(0);
    expect(isMovedCodeLine(result[0]?.current, 6)).toBe(false);
  });

  it("matches independently reordered extractions into the same destination", () => {
    const subtotal =
      "export function subtotal(items: Item[]) {\n  return items.reduce((sum, item) =>\n    sum + item.price * item.quantity, 0);\n}";
    const result = movedCodeRanges([
      {
        path: "old.ts",
        previousSource: `${shipping}\n${subtotal}`,
        currentSource: "",
      },
      {
        path: "new.ts",
        previousSource: "",
        currentSource: `${subtotal}\n${shipping.replace("50", "75")}`,
      },
    ]);
    expect(result[1]?.current).toEqual([
      { startLine: 1, endLine: 5 },
      { startLine: 7, endLine: 8 },
    ]);
    expect(isMovedCodeLine(result[0]?.previous, 2)).toBe(false);
    expect(isMovedCodeLine(result[1]?.current, 6)).toBe(false);
  });

  it("does not classify copies of retained code as moves", () => {
    const files = extraction();
    const original = files[0];
    if (original) original.currentSource = shipping;
    expect(movedCodeRanges(files)).toEqual([]);
  });

  it("leaves duplicate destinations ambiguous", () => {
    expect(
      movedCodeRanges([
        ...extraction(),
        { path: "duplicate.ts", previousSource: "", currentSource: shipping },
      ]),
    ).toEqual([]);
  });

  it("does not infer moves from imports, comments or repeated delimiters", () => {
    expect(
      movedCodeRanges(
        extraction('import { x } from "./x";\n// unchanged comment\n}\n}'),
      ),
    ).toEqual([]);
    expect(
      movedCodeRanges([
        {
          path: "a.ts",
          previousSource:
            'import { x } from "./x";\n// unchanged comment\n}\n}',
          currentSource: "",
        },
        {
          path: "b.ts",
          previousSource: "",
          currentSource: 'import { x } from "./x";\n// unchanged comment\n}\n}',
        },
      ]),
    ).toEqual([]);
  });

  it("keeps whitespace edits highlighted even within matched blocks", () => {
    const result = movedCodeRanges(
      extraction(shipping.replace("  if", "    if")),
    );
    expect(isMovedCodeLine(result[1]?.current, 2)).toBe(false);
    expect(isMovedCodeLine(result[1]?.current, 1)).toBe(true);
  });

  it("does not dim a substantial rewrite sharing one statement", () => {
    expect(
      movedCodeRanges(
        extraction(
          "export function shippingCost(subtotal: number) {\n  const rate = lookupRate(subtotal);\n  return calculateShipping(rate);\n}",
        ),
      ),
    ).toEqual([]);
  });

  it("uses verified renamed-file provenance while preserving its edits", () => {
    const result = movedCodeRanges([
      {
        path: "new.ts",
        previousPath: "old.ts",
        previousSource: shipping,
        currentSource: shipping.replace("50", "75"),
      },
    ]);
    expect(result[0]?.current).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 3, endLine: 4 },
    ]);
  });

  it("matches large blocks while preserving their edits", () => {
    const large = Array.from(
      { length: 450 },
      (_, index) => `  const value${index} = ${index};`,
    ).join("\n");
    expect(movedCodeRanges(extraction(large)).length).toBe(0);
    const result = movedCodeRanges([
      { path: "old.ts", previousSource: large, currentSource: "" },
      {
        path: "new.ts",
        previousSource: "",
        currentSource: large.replace("value200 = 200", "value200 = 201"),
      },
    ]);
    expect(isMovedCodeLine(result[1]?.current, 200)).toBe(true);
    expect(isMovedCodeLine(result[1]?.current, 201)).toBe(false);
    expect(isMovedCodeLine(result[1]?.current, 450)).toBe(true);
  });
});
