import { describe, expect, it } from "vitest";
import {
  type ProgressUnit,
  progressFileCategory,
  reviewProgressBreakdown,
} from "./review-progress";

/** Makes a review unit without loading its source bytes. */
function unit(
  path: string,
  language: string,
  lines: number,
  status = "pending",
): ProgressUnit {
  return { path, language, changedLineCount: lines, status, kind: "file" };
}

describe("review progress breakdown", () => {
  it("keeps JSON, TOML and lockfiles out of code even with an incorrect stored language", () => {
    for (const path of [
      "snapshot.json",
      "Cargo.toml",
      "pnpm-lock.yaml",
      "yarn.lock",
      "settings.JSONC",
    ]) {
      expect(progressFileCategory(path, "typescript")).toBe("data");
    }
    expect(progressFileCategory("README.md", "text")).toBe("docs");
    expect(progressFileCategory("widget.tsx", "tsx")).toBe("code");
    expect(progressFileCategory("LICENSE", "text")).toBe("other");
  });

  it("counts files once across units, includes deleted lines, and only credits signed-off work", () => {
    const result = reviewProgressBreakdown([
      unit("app.ts", "typescript", 100, "signed_off"),
      { ...unit("app.ts", "typescript", 20, "waiting"), kind: "function" },
      unit("deleted.ts", "typescript", 30),
      unit("snapshot.json", "json", 44000),
      unit("Cargo.toml", "toml", 50, "signed_off"),
      unit("README.md", "markdown", 4),
      { ...unit("image.png", "text", 1, "signed_off"), kind: "binary" },
    ]);
    expect(
      result.map(({ key, files, lines, reviewedLines }) => ({
        key,
        files,
        lines,
        reviewedLines,
      })),
    ).toEqual([
      { key: "code", files: 2, lines: 150, reviewedLines: 100 },
      { key: "data", files: 2, lines: 44050, reviewedLines: 50 },
      { key: "docs", files: 1, lines: 4, reviewedLines: 0 },
      { key: "other", files: 1, lines: 0, reviewedLines: 0 },
    ]);
    expect(result[0]?.types).toEqual([
      { label: ".ts", files: 2, lines: 150, reviewedLines: 100 },
    ]);
    expect(result.reduce((sum, group) => sum + group.lines, 0)).toBe(44204);
  });

  it("has no invented code progress for a data-only or empty PR", () => {
    expect(reviewProgressBreakdown([])).toEqual([]);
    expect(
      reviewProgressBreakdown([unit("data.json", "json", 100)])[0]?.key,
    ).toBe("data");
  });
});
