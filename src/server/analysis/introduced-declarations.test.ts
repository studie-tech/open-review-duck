import { afterEach, describe, expect, it, vi } from "vitest";
import { clusterReviewConcepts, validateConceptPartition } from "./concepts";
import { analyzeFiles } from "./engine";
import type { SourceFile } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Returns the units a reviewer signs off, dropping the file context record. */
function reviewUnits(file: SourceFile) {
  return analyzeFiles([file]).units.filter(({ kind }) => kind !== "file");
}

/** The same container holding `count` plain fields, in each language. */
const containers = [
  {
    language: "TypeScript",
    lastMember: "field9",
    path: "config.ts",
    preamble: "export const port = 8080;",
    name: "ServerConfig",
    build: (count: number) =>
      [
        "export class ServerConfig {",
        ...Array.from({ length: count }, (_, i) => `  field${i} = ${i};`),
        "}",
      ].join("\n"),
  },
  {
    language: "Python",
    lastMember: "field9",
    path: "config.py",
    preamble: "PORT = 8080",
    name: "ServerConfig",
    build: (count: number) =>
      [
        "class ServerConfig:",
        ...Array.from({ length: count }, (_, i) => `    field${i} = ${i}`),
      ].join("\n"),
  },
  {
    language: "Go",
    lastMember: "Field9",
    path: "config.go",
    preamble: "package main",
    name: "ServerConfig",
    build: (count: number) =>
      [
        "type ServerConfig struct {",
        ...Array.from({ length: count }, (_, i) => `\tField${i} int`),
        "}",
      ].join("\n"),
  },
];

describe("a declaration this revision introduces", () => {
  it.each(containers)(
    "is one card however many members a $language revision adds with it",
    ({ path, preamble, name, build, lastMember }) => {
      // Ten fields of a type nobody has read are not ten decisions. Nobody can
      // judge one of them without the declaration around it, so the reviewer
      // is asked once.
      const units = reviewUnits({
        path,
        previousContent: `${preamble}\n`,
        content: `${preamble}\n\n${build(10)}\n`,
        changeType: "modified",
      });

      expect(units).toHaveLength(1);
      expect(units[0]).toMatchObject({ name });
      expect(units[0]?.source).toContain(lastMember);
    },
  );

  it.each(containers)(
    "leaves a $language member that changed inside an existing one on its own",
    ({ path, preamble, name, build }) => {
      const before = `${preamble}\n\n${build(3)}\n`;
      const units = reviewUnits({
        path,
        previousContent: before,
        content: before.replace(/([Ff]ield1) = 1|([Ff]ield1) int/, (match) =>
          match.includes("int") ? "Field1 int64" : "field1 = 99",
        ),
        changeType: "modified",
      });

      expect(units).toHaveLength(1);
      expect(units[0]?.name).not.toBe(name);
      expect(units[0]?.name).toContain("ield1");
    },
  );

  it("gives a member added to an existing declaration its own card", () => {
    const { path, preamble, build } = containers[0] as (typeof containers)[0];

    const units = reviewUnits({
      path,
      previousContent: `${preamble}\n\n${build(3)}\n`,
      content: `${preamble}\n\n${build(4)}\n`,
      changeType: "modified",
    });

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ name: "ServerConfig.field3" });
  });

  it("reads an added file's declarations whole", () => {
    const { path, build } = containers[0] as (typeof containers)[0];

    const units = reviewUnits({
      path,
      content: `${build(5)}\n`,
      changeType: "added",
    });

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ name: "ServerConfig" });
  });

  it("keeps a file analyzed without a revision split by member", () => {
    // No change type states a revision whose previous side was not supplied,
    // which is read as a modification — the file is not new, so its members
    // are still what a reviewer signs off.
    const { path, build } = containers[0] as (typeof containers)[0];

    expect(reviewUnits({ path, content: `${build(5)}\n` }).length).toBe(6);
  });

  it("lets an introduced declaration answer for a nested one", () => {
    const units = reviewUnits({
      path: "pond.ts",
      previousContent: "export const x = 1;\n",
      content: [
        "export const x = 1;",
        "",
        "export namespace Pond {",
        "  export class Duck {",
        '    sound = "quack";',
        "  }",
        "}",
        "",
      ].join("\n"),
      changeType: "modified",
    });

    expect(units).toHaveLength(1);
    expect(units[0]?.source).toContain("class Duck");
  });

  it("leaves two unrelated introduced declarations apart", () => {
    // Absorption is containment, so declarations that merely arrive together
    // must not collapse into each other.
    const units = reviewUnits({
      path: "pair.ts",
      previousContent: "export const x = 1;\n",
      content: [
        "export const x = 1;",
        "",
        "export function first() { return 1; }",
        "",
        "export function second() { return 2; }",
        "",
      ].join("\n"),
      changeType: "modified",
    });

    expect(units.map(({ name }) => name)).toEqual(["first", "second"]);
  });

  it("adds no whole-container card when a member is appended to one", () => {
    // A container emitted at its full extent rather than as a header used to
    // arrive alongside its own members, overlapping them.
    const units = reviewUnits({
      path: "sound.kt",
      previousContent: "enum class Sound {\n    A,\n    B,\n}\n",
      content: "enum class Sound {\n    A,\n    B,\n    C,\n}\n",
      changeType: "modified",
    });

    expect(units).toHaveLength(1);
    expect(units[0]?.name).toContain("C");
  });

  it("leaves no changed line of an introduced declaration unrendered", () => {
    // The closing brace of a new container used to belong to nothing: the
    // shell stopped at the header and the members each held one line.
    const { path, preamble, build } = containers[0] as (typeof containers)[0];
    const file: SourceFile = {
      path,
      previousContent: `${preamble}\n`,
      content: `${preamble}\n\n${build(10)}\n`,
      changeType: "modified",
    };
    const units = reviewUnits(file);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    validateConceptPartition(units, clusterReviewConcepts(units), [file]);

    expect(warn).not.toHaveBeenCalled();
  });
});
