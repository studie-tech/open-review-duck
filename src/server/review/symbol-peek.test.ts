import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const FACTCHECK_SOURCE = [
  "export interface GuideFactCheckIssue {",
  "  field: string;",
  "  message: string;",
  "}",
  "",
  "export const factCheckGuideProse = (text: string): GuideFactCheckIssue[] => (",
  "  []",
  ");",
].join("\n");

describe("symbol peek file parse", () => {
  it("loads a cold TypeScript grammar so a same-file interface can be named", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { parsedSymbolFileFromSource } = await import("./symbol-peek");

    const parsed = await parsedSymbolFileFromSource(
      "app/src/libs/guide/factcheck.ts",
      FACTCHECK_SOURCE,
      "typescript",
    );

    expect(parsed.declarations.get("GuideFactCheckIssue")).toMatchObject({
      focusLine: 1,
      kind: "definition",
      name: "GuideFactCheckIssue",
      startLine: 1,
      unitKind: "class",
    });
    expect(parsed.declarations.get("factCheckGuideProse")).toMatchObject({
      focusLine: 6,
      name: "factCheckGuideProse",
    });
  });
});
