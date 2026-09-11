import { describe, expect, it } from "vitest";
import {
  findImportedDeclarationLine,
  findImportedReexport,
} from "./declarations";

describe("tree-sitter declaration lookup", () => {
  it("finds TypeScript, Python, Go, and Rust declarations", () => {
    expect(
      findImportedDeclarationLine(
        [
          "export const api = createApi();",
          "",
          "export type RouterOutputs = inferOutputs<AppRouter>;",
        ].join("\n"),
        "RouterOutputs",
        "typescript",
        20,
      ),
    ).toBe(22);
    expect(
      findImportedDeclarationLine(
        "class ReviewTarget:\n    pass",
        "ReviewTarget",
        "python",
      ),
    ).toBe(1);
    expect(
      findImportedDeclarationLine(
        "package review\n\nfunc Normalize(path string) string { return path }\n",
        "Normalize",
        "go",
      ),
    ).toBe(3);
    expect(
      findImportedDeclarationLine(
        "pub fn normalize(path: &str) -> &str { path }\n",
        "normalize",
        "rust",
      ),
    ).toBe(1);
  });

  it("follows a TypeScript barrel re-export", () => {
    expect(
      findImportedReexport(
        'export { showFormErrorToast } from "./form-toast";\n',
        "showFormErrorToast",
        "typescript",
      ),
    ).toEqual({
      imported: "showFormErrorToast",
      specifier: "./form-toast",
    });
  });
});
