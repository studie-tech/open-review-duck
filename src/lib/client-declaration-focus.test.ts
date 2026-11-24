import { describe, expect, it, vi } from "vitest";
import { Parser } from "web-tree-sitter";
import { findImportedDeclarationLine } from "./tree-sitter-import-navigation";

describe("import preview declaration focus", () => {
  it("still locates a declaration inside an ordinary module", async () => {
    await expect(
      findImportedDeclarationLine(
        "// heading\n\nexport const target = 1;",
        "target",
        "typescript",
        10,
      ),
    ).resolves.toBe(12);
  });

  it("opens an oversized module without requiring a declaration focus", async () => {
    const source = `${"// heading\n".repeat(10_000)}export const target = 1;`;
    await expect(
      findImportedDeclarationLine(source, "target", "typescript"),
    ).resolves.toBeUndefined();
  });

  it("keeps the preview available when its grammar times out", async () => {
    const parse = vi.spyOn(Parser.prototype, "parse").mockReturnValue(null);
    try {
      await expect(
        findImportedDeclarationLine(
          "export const timedOutTarget = 1;",
          "timedOutTarget",
          "typescript",
        ),
      ).resolves.toBeUndefined();
    } finally {
      parse.mockRestore();
    }
  });
});
