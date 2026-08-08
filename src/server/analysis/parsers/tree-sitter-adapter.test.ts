import { describe, expect, it } from "vitest";
import { analyzeFiles } from "../engine";
import type { TreeSitterLanguage } from "../tree-sitter";
import { withPreparedTreeSitterLanguages } from "../tree-sitter";

/** Analyzes one added fixture through the generic shape-driven adapter. */
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

/**
 * A declaration truncated to its opening line, immediately followed by an
 * anonymous module unit, means the shape config declared a body that nothing
 * ever claims as a unit. The body is then unreviewable in its own right.
 */
function orphanedBodies(units: Awaited<ReturnType<typeof analyze>>) {
  return units.filter((unit, index) => {
    const next = units[index + 1];
    return (
      unit.kind !== "module" &&
      unit.startLine === unit.endLine &&
      next?.kind === "module" &&
      next.startLine === unit.endLine + 1
    );
  });
}

describe("shape-driven review analysis", () => {
  it("keeps a SQL table definition whole instead of orphaning its columns", async () => {
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
    expect(table).toBeDefined();
    // The whole statement, not just its opening line.
    expect(table?.startLine).toBe(1);
    expect(table?.endLine).toBeGreaterThanOrEqual(4);
    expect(orphanedBodies(units)).toEqual([]);
    expect(units.some(({ kind }) => kind === "module")).toBe(false);
  });

  it("extracts field-level units for data-definition languages", async () => {
    const units = await analyze(
      "prisma",
      "prisma/schema.prisma",
      `model Concept {
  id    String @id
  title String
}
`,
    );
    expect(units.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["Concept", "Concept.id", "Concept.title"]),
    );
    expect(orphanedBodies(units)).toEqual([]);
  });
});
