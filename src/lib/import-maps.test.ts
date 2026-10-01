import { describe, expect, it } from "vitest";
import {
  applyImportMappings,
  importMapsFromProjectFiles,
  mappingsFromComposerJson,
  mappingsFromGoMod,
  mappingsFromPackageJson,
  mappingsFromTsconfig,
  parseJsonc,
} from "./import-maps";

describe("project import maps", () => {
  it("reads Node subpath imports, including conditional targets", () => {
    const mappings = mappingsFromPackageJson(
      JSON.stringify({
        imports: {
          "#/*": "./src/*",
          "#utils": {
            types: "./src/utils.ts",
            default: "./src/utils.js",
          },
        },
      }),
      "",
    );

    expect(applyImportMappings("#/lib/toast", mappings)).toEqual([
      "src/lib/toast",
    ]);
    expect(applyImportMappings("#utils", mappings)).toEqual(["src/utils.js"]);
  });

  it("reads tsconfig paths relative to baseUrl and the config directory", () => {
    const { mappings } = mappingsFromTsconfig(
      `{
        // Reviewduck accepts comments and trailing commas
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@/*": ["./src/*"],
            "~/*": ["./src/*"],
          },
        },
      }`,
      "apps/web",
    );

    expect(applyImportMappings("@/lib/toast", mappings)).toEqual([
      "apps/web/src/lib/toast",
    ]);
    expect(applyImportMappings("~/lib/toast", mappings)).toEqual([
      "apps/web/src/lib/toast",
    ]);
  });

  it("parses JSONC objects used by tsconfig files", () => {
    expect(
      parseJsonc(`{
        "compilerOptions": {
          "paths": { "@/*": ["./src/*"] },
        },
      }`),
    ).toEqual({
      compilerOptions: { paths: { "@/*": ["./src/*"] } },
    });
  });

  it("maps a Go module path onto the directory that declared it", () => {
    const mappings = mappingsFromGoMod(
      "module github.com/acme/app\n\ngo 1.22\n",
      "",
    );

    expect(
      applyImportMappings("github.com/acme/app/pkg/foo", mappings),
    ).toEqual(["pkg/foo"]);
    expect(applyImportMappings("github.com/acme/app", mappings)).toEqual([""]);
  });

  it("maps Composer PSR-4 prefixes onto PHP sources", () => {
    const mappings = mappingsFromComposerJson(
      JSON.stringify({
        autoload: { "psr-4": { "App\\": "src/" } },
      }),
      "",
    );

    expect(applyImportMappings("App/Service/Mailer", mappings)).toEqual([
      "src/Service/Mailer",
    ]);
  });

  it("lets a nested package.json override a workspace mapping", () => {
    const context = importMapsFromProjectFiles([
      {
        path: "package.json",
        content: JSON.stringify({ imports: { "#/*": "./src/*" } }),
      },
      {
        path: "apps/web/package.json",
        content: JSON.stringify({ imports: { "#/*": "./app/*" } }),
      },
    ]);

    expect(applyImportMappings("#/lib/toast", context.mappings)).toEqual([
      "apps/web/app/lib/toast",
    ]);
  });

  it("follows a relative tsconfig extends edge already in hand", () => {
    const context = importMapsFromProjectFiles([
      {
        path: "tsconfig.base.json",
        content: JSON.stringify({
          compilerOptions: { paths: { "@/*": ["./src/*"] } },
        }),
      },
      {
        path: "tsconfig.json",
        content: JSON.stringify({
          extends: "./tsconfig.base.json",
          compilerOptions: { paths: { "~/*": ["./src/*"] } },
        }),
      },
    ]);

    expect(applyImportMappings("@/lib/toast", context.mappings)).toEqual([
      "src/lib/toast",
    ]);
    expect(applyImportMappings("~/lib/toast", context.mappings)).toEqual([
      "src/lib/toast",
    ]);
  });

  it("records Cargo.toml directories as crate roots", () => {
    const context = importMapsFromProjectFiles([
      { path: "services/api/Cargo.toml", content: '[package]\nname = "api"\n' },
    ]);

    expect(context.crateRoots).toEqual(["services/api"]);
  });
});
