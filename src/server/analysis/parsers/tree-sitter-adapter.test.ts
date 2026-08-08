import { describe, expect, it } from "vitest";
import { analyzeFiles } from "../engine";
import type { TreeSitterLanguage } from "../tree-sitter";
import { withPreparedTreeSitterLanguages } from "../tree-sitter";

/** Analyzes one added fixture through the shared shape-driven adapter. */
async function analyze(
  language: TreeSitterLanguage,
  path: string,
  content: string,
) {
  const result = await withPreparedTreeSitterLanguages([language], () =>
    analyzeFiles([{ path, content, changeType: "added" }]),
  );
  return result.units
    .filter(({ kind }) => kind !== "file")
    .sort(
      (left, right) =>
        left.startLine - right.startLine || left.endLine - right.endLine,
    );
}

/** Describes units as "start-end kind name" for readable expectations. */
function shape(units: Awaited<ReturnType<typeof analyze>>) {
  return units.map(
    ({ startLine, endLine, kind, name }) =>
      `${startLine}-${endLine} ${kind} ${name}`,
  );
}

/**
 * An anonymous module unit names nothing a reviewer can act on. Wherever one
 * covers a declaration's own body, that declaration was truncated past the
 * point where anything else reviews it.
 */
function anonymousUnits(units: Awaited<ReturnType<typeof analyze>>) {
  return shape(units).filter((entry) => entry.includes("module Module"));
}

describe("declarations whose body no other unit reviews", () => {
  it("keeps a TypeScript interface, enum, and object type alias whole", async () => {
    const units = await analyze(
      "typescript",
      "a/types.ts",
      `export interface ReviewConceptDefinition {
  stableKey: string;
  title: string;
}

export enum Status {
  Pending = "pending",
  Done = "done",
}

export type Config = {
  retries: number;
};
`,
    );
    expect(shape(units)).toEqual([
      "1-4 class ReviewConceptDefinition",
      "6-9 class Status",
      "11-13 class Config",
    ]);
    expect(anonymousUnits(units)).toEqual([]);
  });

  it("keeps a SQL table definition whole", async () => {
    const units = await analyze(
      "sql",
      "drizzle/0001_init.sql",
      `CREATE TABLE "concept" (
\t"id" uuid PRIMARY KEY NOT NULL,
\t"title" text NOT NULL
);
ALTER TABLE "concept" ADD COLUMN "rationale" text;
`,
    );
    const table = units.find(({ name }) => name.includes("concept"));
    expect(table?.startLine).toBe(1);
    expect(table?.endLine).toBeGreaterThanOrEqual(4);
    expect(anonymousUnits(units)).toEqual([]);
  });

  it("keeps a Swift protocol whole while splitting a struct's members", async () => {
    const units = await analyze(
      "swift",
      "a/Service.swift",
      `protocol Greeter {
    var name: String { get }
    func greet() -> String
}

struct Point {
    let x: Int
    let y: Int
}
`,
    );
    expect(shape(units)).toContain("1-4 class Greeter");
    expect(anonymousUnits(units)).toEqual([]);
  });

  it("still splits a class whose members are reviewed on their own", async () => {
    const units = await analyze(
      "typescript",
      "a/service.ts",
      `export class ReviewService {
  private name = "";

  run(): string {
    return this.name;
  }

  rename(next: string): void {
    this.name = next;
  }
}
`,
    );
    // The container stays a header so each member can be signed off alone.
    expect(shape(units)).toEqual([
      "1-1 class ReviewService",
      "2-2 variable ReviewService.name",
      "4-6 method run",
      "8-10 method rename",
    ]);
    // The line closing the class states nothing of its own.
    expect(anonymousUnits(units)).toEqual([]);
  });
});

describe("declaration coverage", () => {
  it("extracts JavaScript class fields rather than leaving them unreviewed", async () => {
    const units = await analyze(
      "javascript",
      "a/store.js",
      `export class Store {
  static instances = 0;
  #items = [];

  add(item) {
    this.#items.push(item);
  }
}
`,
    );
    // Fields carry real content, so they must surface as units of their own.
    expect(units.filter(({ kind }) => kind === "variable")).toHaveLength(2);
    expect(anonymousUnits(units)).toEqual([]);
  });

  it("keeps module-level statements visible instead of absorbing them", async () => {
    const units = await analyze(
      "typescript",
      "a/mixed.ts",
      `const limit = 10;

console.log("booting", limit);

export function load(): number {
  return limit;
}
`,
    );
    // A real top-level statement is reviewable and must not be suppressed.
    expect(anonymousUnits(units)).toEqual(["3-3 module Module statements"]);
  });
});
