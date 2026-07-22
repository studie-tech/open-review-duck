import { describe, expect, it } from "vitest";
import {
  findImportedDeclarationLine,
  findImportTargetUnit,
  importPathCandidates,
  importReferenceIsUsed,
  isImportOnlySource,
  parseImportReferences,
  parseImportStatements,
  resolveImportPath,
  resolvePythonImportedSubmodulePath,
} from "./import-navigation";

describe("parseImportReferences", () => {
  it("finds named, aliased, default, namespace, and side-effect imports", () => {
    const source = [
      'import primary, { alpha, beta as localBeta } from "./helpers";',
      'import * as tools from "~/lib/tools";',
      'import "./setup";',
    ].join("\n");

    expect(parseImportReferences(source, "typescript")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          imported: "default",
          local: "primary",
          specifier: "./helpers",
        }),
        expect.objectContaining({
          imported: "alpha",
          local: "alpha",
          specifier: "./helpers",
        }),
        expect.objectContaining({
          imported: "beta",
          local: "localBeta",
          specifier: "./helpers",
        }),
        expect.objectContaining({
          imported: "*",
          local: "tools",
          specifier: "~/lib/tools",
        }),
        expect.objectContaining({
          kind: "module",
          specifier: "./setup",
        }),
      ]),
    );
    for (const reference of parseImportReferences(source, "typescript")) {
      expect(source.slice(reference.from, reference.to)).not.toHaveLength(0);
    }
  });

  it("finds Python imports, including aliases and parent modules", () => {
    const source = [
      "from ..review.navigation import next_pending as next_item, current_item",
      "from .models import (User, Team as LocalTeam)",
      "import local.tools as tools, os, package.submodule",
    ].join("\n");

    expect(parseImportReferences(source, "python")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          imported: "next_pending",
          local: "next_item",
          specifier: "..review.navigation",
        }),
        expect.objectContaining({
          imported: "current_item",
          local: "current_item",
        }),
        expect.objectContaining({
          kind: "module",
          local: "tools",
          specifier: "local.tools",
        }),
        expect.objectContaining({
          imported: "Team",
          local: "LocalTeam",
          specifier: ".models",
        }),
        expect.objectContaining({
          kind: "module",
          local: "os",
          specifier: "os",
        }),
        expect.objectContaining({
          kind: "module",
          local: "package",
          specifier: "package.submodule",
        }),
      ]),
    );
  });

  it("groups complete import statements for contextual display", () => {
    const source = [
      'import primary, { alpha, beta as localBeta } from "./helpers";',
      "import type {",
      "  ReviewUnit,",
      '} from "./types";',
      "",
      "export function run() { return alpha(); }",
    ].join("\n");
    const statements = parseImportStatements(source, "typescript");

    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatchObject({ startLine: 1, endLine: 1 });
    expect(statements[1]).toMatchObject({
      startLine: 2,
      endLine: 4,
      source: expect.stringContaining("ReviewUnit"),
    });
  });

  it("keeps imports visible as context across additional languages", () => {
    const fixtures = [
      ["java", "package com.acme;\nimport java.util.List;"],
      ["csharp", "global using System.Text;"],
      ["c", "#include <stddef.h>"],
      ["cpp", "#include <vector>\nimport widgets.core;"],
      ["php", 'require_once "support.php";'],
      ["shell", 'source "./shared.sh"'],
      ["ruby", 'require_relative "support"'],
      ["rust", "use crate::model::{User, Team};"],
      ["lua", 'local support = require("./support")'],
      ["go", 'import (\n  "fmt"\n  "net/http"\n)'],
      ["makefile", "-include local.mk"],
      ["kotlin", "package app.review\nimport app.model.User"],
    ] as const;

    for (const [language, source] of fixtures) {
      expect(parseImportStatements(source, language).length).toBeGreaterThan(0);
    }
  });

  it("distinguishes import-only source and bindings used by a unit", () => {
    const imports = [
      "// Shared dependencies",
      'import { alpha, beta as localBeta } from "./helpers";',
    ].join("\n");
    const references = parseImportReferences(imports, "typescript");
    const alpha = references.find(({ local }) => local === "alpha");
    const localBeta = references.find(({ local }) => local === "localBeta");

    expect(isImportOnlySource(imports, "typescript")).toBe(true);
    expect(isImportOnlySource(`"use client";\n${imports}`, "typescript")).toBe(
      true,
    );
    expect(
      isImportOnlySource(
        `"""Service dependencies."""\nfrom helpers import alpha`,
        "python",
      ),
    ).toBe(true);
    expect(
      isImportOnlySource(
        `${imports}\ninterface Options { ready: boolean }`,
        "typescript",
      ),
    ).toBe(false);
    expect(alpha).toBeDefined();
    expect(localBeta).toBeDefined();
    if (!alpha || !localBeta) throw new Error("Expected parsed imports");
    expect(importReferenceIsUsed(alpha, "return alpha();")).toBe(true);
    expect(importReferenceIsUsed(localBeta, "return alpha();")).toBe(false);
  });
});

describe("import path resolution", () => {
  it("resolves relative TypeScript modules and index files", () => {
    const paths = new Set([
      "src/lib/review-navigation.ts",
      "src/components/panel/index.tsx",
    ]);
    expect(
      resolveImportPath(
        "src/lib/review-navigation.test.ts",
        "./review-navigation",
        paths,
        "typescript",
      ),
    ).toBe("src/lib/review-navigation.ts");
    expect(
      resolveImportPath(
        "src/app/page.tsx",
        "../components/panel",
        paths,
        "typescript",
      ),
    ).toBe("src/components/panel/index.tsx");
  });

  it("resolves common T3 aliases and Python modules", () => {
    expect(
      importPathCandidates(
        "src/components/review.tsx",
        "~/lib/navigation",
        "typescript",
      ),
    ).toContain("src/lib/navigation.ts");
    expect(
      importPathCandidates(
        "package/reviews/test_navigation.py",
        "..navigation",
        "python",
      ),
    ).toContain("package/navigation.py");
    expect(
      resolveImportPath(
        "src/package/service.py",
        "package.navigation",
        new Set(["src/package/navigation.py"]),
        "python",
      ),
    ).toBe("src/package/navigation.py");
    expect(
      resolvePythonImportedSubmodulePath(
        "src/package/service.py",
        ".",
        "navigation",
        new Set(["src/package/navigation.py"]),
      ),
    ).toBe("src/package/navigation.py");
  });

  it("rejects repository traversal", () => {
    expect(
      importPathCandidates("src/app/page.tsx", "../../../secret", "typescript"),
    ).toEqual([]);
  });

  it("maps named imports to exact units and module imports to files", () => {
    const units = [
      {
        id: "function",
        path: "src/helpers.ts",
        kind: "function",
        name: "normalize",
      },
      {
        id: "module",
        path: "src/helpers.ts",
        kind: "module",
        name: "Test imports",
      },
      {
        id: "file",
        path: "src/helpers.ts",
        kind: "file",
        name: "helpers.ts",
      },
    ];
    expect(
      findImportTargetUnit(
        "src/service.ts",
        "typescript",
        {
          specifier: "./helpers",
          imported: "normalize",
          kind: "named",
        },
        units,
      )?.exactUnit,
    ).toMatchObject({ id: "function" });
    expect(
      findImportTargetUnit(
        "src/service.ts",
        "typescript",
        {
          specifier: "./helpers",
          imported: "default",
          kind: "default",
        },
        units,
      )?.exactUnit,
    ).toMatchObject({ id: "file" });
  });

  it("opens Python package submodules imported from their parent package", () => {
    const units = [
      {
        id: "normalize",
        path: "src/acme/helpers.py",
        kind: "function",
        name: "normalize",
      },
      {
        id: "helpers-file",
        path: "src/acme/helpers.py",
        kind: "file",
        name: "helpers.py",
      },
    ];

    expect(
      findImportTargetUnit(
        "src/acme/service.py",
        "python",
        {
          specifier: ".",
          imported: "helpers",
          kind: "named",
        },
        units,
      ),
    ).toMatchObject({
      targetPath: "src/acme/helpers.py",
      moduleUnit: { id: "helpers-file" },
    });
  });

  it("locates declarations that are not standalone review units", () => {
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
  });
});
