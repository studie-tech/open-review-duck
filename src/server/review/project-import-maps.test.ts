import { describe, expect, it } from "vitest";
import { projectImportConfigPaths } from "./project-import-maps";

describe("project import config discovery", () => {
  it("always includes repository-root configs", () => {
    expect(projectImportConfigPaths("src/app/page.tsx")).toEqual(
      expect.arrayContaining([
        "package.json",
        "tsconfig.json",
        "go.mod",
        "composer.json",
        "Cargo.toml",
      ]),
    );
  });

  it("also reads the nearest package and tsconfig in a monorepo", () => {
    expect(projectImportConfigPaths("apps/web/src/app/page.tsx")).toEqual(
      expect.arrayContaining([
        "package.json",
        "apps/web/package.json",
        "apps/web/tsconfig.json",
        "apps/web/src/package.json",
        "apps/web/src/app/package.json",
      ]),
    );
  });
});
