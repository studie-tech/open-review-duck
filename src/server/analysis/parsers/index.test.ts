import { describe, expect, it } from "vitest";
import { supportedLanguages } from "../types";
import {
  languageAdapterForFile,
  languageAdapterForPath,
  languageAdapters,
} from ".";

describe("language parser registry", () => {
  it("registers every parser exactly once", () => {
    const languages = languageAdapters.map(({ language }) => language);

    expect(new Set(languages)).toEqual(
      new Set(supportedLanguages.filter((language) => language !== "text")),
    );
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
    ["migration.sql", "sql"],
    ["schema.graphql", "graphql"],
    ["component.svelte", "svelte"],
    ["component.astro", "astro"],
    ["Dockerfile", "dockerfile"],
    ["readme.mdx", "mdx"],
    ["module.sv", "systemverilog"],
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

  it("leaves genuinely unknown text formats to the full-file fallback", () => {
    expect(languageAdapterForPath("notes.unknown")).toBeUndefined();
  });
});

describe("a header C and C++ both call .h", () => {
  const cppHeader = [
    "#pragma once",
    "namespace pond {",
    "class Registry {",
    " public:",
    "  void Add(const std::string &name);",
    "};",
    "}  // namespace pond",
    "",
  ].join("\n");
  const cHeader = "#pragma once\nint pond_size(void);\n";

  it("reads C++ syntax with the C++ grammar", () => {
    expect(
      languageAdapterForFile({ path: "pond/registry.h", content: cppHeader })
        ?.language,
    ).toBe("cpp");
  });

  it("leaves a C header to the C grammar", () => {
    expect(
      languageAdapterForFile({ path: "pond/registry.h", content: cHeader })
        ?.language,
    ).toBe("c");
  });

  it("does not take a header named for C++ away from it", () => {
    expect(
      languageAdapterForFile({ path: "pond/registry.hpp", content: cppHeader })
        ?.language,
    ).toBe("cpp");
  });
});
