import { describe, expect, it } from "vitest";
import {
  formatReviewSourceBytes,
  HEAVY_DATA_CHANGE_LINES,
  HEAVY_DATA_SOURCE_BYTES,
  isDataOrGeneratedReviewPath,
  isHeavyReviewSource,
  reviewFileCardStartsExpanded,
  reviewPathExtension,
  reviewSourceByteLength,
  reviewSourceKindLabel,
  reviewSourceLineCount,
} from "./review-source-display";

describe("review source display", () => {
  it("recognizes serialized data paths without treating code as data", () => {
    expect(
      isDataOrGeneratedReviewPath(
        "app/drizzle/migrations/meta/0039_snapshot.json",
      ),
    ).toBe(true);
    expect(isDataOrGeneratedReviewPath("pnpm-lock.yaml")).toBe(true);
    expect(isDataOrGeneratedReviewPath("Cargo.lock")).toBe(true);
    expect(isDataOrGeneratedReviewPath("src/review-workspace.tsx")).toBe(false);
    expect(reviewPathExtension("meta/0039_snapshot.json")).toBe("json");
  });

  it("counts lines without splitting the source into an array", () => {
    expect(reviewSourceLineCount("")).toBe(0);
    expect(reviewSourceLineCount("{}")).toBe(1);
    expect(reviewSourceLineCount('{\n  "a": 1\n}\n')).toBe(4);
  });

  it("hides large JSON and keeps small configs visible", () => {
    expect(
      isHeavyReviewSource({
        path: "package.json",
        language: "json",
        changedLineCount: HEAVY_DATA_CHANGE_LINES - 1,
        source: '{ "name": "pond" }',
      }),
    ).toBe(false);
    expect(
      isHeavyReviewSource({
        path: "app/drizzle/migrations/meta/0039_snapshot.json",
        language: "json",
        changedLineCount: HEAVY_DATA_CHANGE_LINES,
      }),
    ).toBe(true);
    expect(
      isHeavyReviewSource({
        path: "generated/blob.json",
        language: "json",
        changedLineCount: 1,
        source: "x".repeat(HEAVY_DATA_SOURCE_BYTES),
      }),
    ).toBe(true);
  });

  it("never auto-hides ordinary source just because it is long", () => {
    expect(
      isHeavyReviewSource({
        path: "src/review-workspace.tsx",
        language: "typescript",
        changedLineCount: 8_000,
      }),
    ).toBe(false);
  });

  it("folds reviewed cards and heavy data, and leaves the rest open", () => {
    expect(reviewFileCardStartsExpanded({ reviewed: true, heavy: false })).toBe(
      false,
    );
    expect(reviewFileCardStartsExpanded({ reviewed: false, heavy: true })).toBe(
      false,
    );
    expect(
      reviewFileCardStartsExpanded({ reviewed: false, heavy: false }),
    ).toBe(true);
  });

  it("labels hidden source from the language or the path", () => {
    expect(
      reviewSourceKindLabel({
        path: "meta/0039_snapshot.json",
        language: "json",
      }),
    ).toBe("json");
    expect(reviewSourceKindLabel({ path: "Cargo.lock" })).toBe("lock");
    expect(reviewSourceKindLabel({ language: "text" })).toBe("source");
    expect(formatReviewSourceBytes(800)).toBe("800 B");
    expect(formatReviewSourceBytes(20_480)).toBe("20 KB");
    expect(formatReviewSourceBytes(2_200_000)).toBe("2.1 MB");
  });

  it("prefers a stored byte range and ignores analysis placeholders", () => {
    expect(
      reviewSourceByteLength({ startByte: 0, endByte: 2_048, source: "" }),
    ).toBe(2_048);
    expect(reviewSourceByteLength({ source: "const answer = 42;" })).toBe(18);
    expect(
      reviewSourceByteLength({
        startByte: 0,
        endByte: 0,
        source: "Binary file — content is not displayed.",
      }),
    ).toBeUndefined();
    expect(reviewSourceByteLength({ source: "" })).toBeUndefined();
    expect(reviewSourceByteLength()).toBeUndefined();
  });
});
