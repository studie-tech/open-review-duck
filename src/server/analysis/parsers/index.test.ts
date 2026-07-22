import { describe, expect, it } from "vitest";
import {
  languageAdapterForFile,
  languageAdapterForPath,
  languageAdapters,
} from ".";

const expectedParserLanguages = [
  "typescript",
  "javascript",
  "python",
  "java",
  "csharp",
  "cpp",
  "php",
  "shell",
  "c",
  "hcl",
  "rust",
  "ruby",
  "lua",
  "go",
  "makefile",
  "kotlin",
] as const;

describe("language parser registry", () => {
  it("registers every parser exactly once", () => {
    const languages = languageAdapters.map(({ language }) => language);

    expect(languages).toEqual(expectedParserLanguages);
    expect(new Set(languages).size).toBe(languages.length);
  });

  it.each([
    ["component.tsx", "typescript"],
    ["worker.mjs", "javascript"],
    ["service.py", "python"],
    ["Service.java", "java"],
    ["Service.cs", "csharp"],
    ["service.cpp", "cpp"],
    ["service.php", "php"],
    ["release.sh", "shell"],
    ["service.c", "c"],
    ["main.tf", "hcl"],
    ["lib.rs", "rust"],
    ["Rakefile", "ruby"],
    ["plugin.lua", "lua"],
    ["service.go", "go"],
    ["Makefile", "makefile"],
    ["Service.kt", "kotlin"],
  ])("maps %s to %s", (path, language) => {
    expect(languageAdapterForPath(path)?.language).toBe(language);
  });

  it("recognizes conservative extensionless script signatures", () => {
    expect(
      languageAdapterForFile({
        path: "bin/release",
        content: "#!/usr/bin/env bash\nset -euo pipefail\n",
      })?.language,
    ).toBe("shell");
    expect(
      languageAdapterForFile({
        path: "bin/report",
        content: "#!/usr/bin/env ruby\nputs :ready\n",
      })?.language,
    ).toBe("ruby");
  });

  it("leaves unknown text formats to the full-file fallback", () => {
    expect(languageAdapterForPath("config/settings.json")).toBeUndefined();
  });
});
