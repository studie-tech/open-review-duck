import { describe, expect, it } from "vitest";
import {
  compileRepositoryGlob,
  normalizeRepositoryPath,
} from "./repository-glob";

/** Applies repository path normalization before testing a compiled pattern. */
function matches(pattern: string, path: string) {
  return compileRepositoryGlob(pattern).test(normalizeRepositoryPath(path));
}

describe("repository glob matching", () => {
  it.each([
    ["*.ts", "index.ts", true],
    ["*.ts", "src/index.ts", false],
    ["**/*.ts", "index.ts", true],
    ["**/*.ts", "src/server/index.ts", true],
    ["src/*.ts", "src/server/index.ts", false],
    ["src/**/index.ts", "src/index.ts", true],
    ["src/**/index.ts", "src/server/deep/index.ts", true],
    ["assets/**", "assets/icons/app/logo.svg", true],
    ["src/?ain.ts", "src/main.ts", true],
    ["src/?ain.ts", "src/rain.ts", true],
    ["src/?ain.ts", "src/domain.ts", false],
    ["**/*.{js,tsx}", "src/app.tsx", true],
    ["**/*.{js,tsx}", "src/app.ts", false],
    ["src/file[1]+.ts", "src/file[1]+.ts", true],
    ["src/file[1]+.ts", "src/file11.ts", false],
    ["package.json", "package.json.backup", false],
    ["package.json", "config/package.json", false],
    ["README.MD", "readme.md", true],
  ])("matches %s against %s as %s", (pattern, path, expected) => {
    expect(matches(pattern, path)).toBe(expected);
  });

  it.each([
    ["./src/main.ts", "src/main.ts"],
    ["/src/main.ts", "src/main.ts"],
    ["///src/main.ts", "src/main.ts"],
    ["src\\server\\main.ts", "src/server/main.ts"],
    [".\\src\\server\\main.ts", "src/server/main.ts"],
  ])("normalizes %s", (path, expected) => {
    expect(normalizeRepositoryPath(path)).toBe(expected);
  });
});
