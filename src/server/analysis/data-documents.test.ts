import { afterEach, describe, expect, it, vi } from "vitest";
import { languageAdapters } from "./adapters";
import { clusterReviewConcepts, validateConceptPartition } from "./concepts";
import { analyzeFiles } from "./engine";
import type { SourceFile, SupportedLanguage } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Returns the units a reviewer signs off, dropping the file context record. */
function reviewUnits(files: SourceFile[]) {
  return analyzeFiles(files).units.filter(({ kind }) => kind !== "file");
}

const manifest = [
  "{",
  '  "name": "pond",',
  '  "version": "1.2.0",',
  '  "scripts": {',
  '    "start": "pond serve",',
  '    "check": "pond lint"',
  "  },",
  '  "dependencies": {',
  '    "quack": "^1.0.0",',
  '    "ripple": "^2.3.1"',
  "  }",
  "}",
  "",
].join("\n");

const workflow = [
  "name: pond",
  "on:",
  "  push:",
  "    branches: [main]",
  "jobs:",
  "  lint:",
  "    runs-on: marsh",
  "    steps:",
  "      - run: pond lint",
  "  check:",
  "    runs-on: marsh",
  "    steps:",
  "      - run: pond check",
  "",
].join("\n");

const settings = [
  "[pond]",
  'name = "pond"',
  'version = "1.2.0"',
  "",
  "[pond.limits]",
  "depth = 3",
  "width = 8",
  "",
].join("\n");

const catalogue = [
  "<pond>",
  "  <duck>",
  "    <sound>quack</sound>",
  "  </duck>",
  "  <duck>",
  "    <sound>honk</sound>",
  "  </duck>",
  "</pond>",
  "",
].join("\n");

const dataDocuments: Array<{
  language: SupportedLanguage;
  path: string;
  content: string;
}> = [
  { language: "json", path: "pond.json", content: manifest },
  { language: "yaml", path: "ci/pond.yaml", content: workflow },
  { language: "toml", path: "pond.toml", content: settings },
  { language: "xml", path: "data/pond.xml", content: catalogue },
];

describe("data documents", () => {
  it.each(dataDocuments)(
    "reviews a whole $language file as one unit",
    ({ language, path, content }) => {
      const units = reviewUnits([{ path, content, changeType: "added" }]);

      expect(units).toHaveLength(1);
      expect(units[0]).toMatchObject({
        language,
        kind: "module",
        name: path.split("/").at(-1),
        startLine: 1,
        endLine: content.split("\n").length,
      });
      expect(units[0]?.source).toBe(content);
    },
  );

  it("asks for one sign-off when a manifest changes in two places", () => {
    const revised = manifest
      .replace('"1.2.0"', '"1.3.0"')
      .replace('"^2.3.1"', '"^2.4.0"');
    const units = reviewUnits([
      {
        path: "pond.json",
        content: revised,
        previousContent: manifest,
        changeType: "modified",
      },
    ]);
    const concepts = clusterReviewConcepts(units);

    expect(units).toHaveLength(1);
    expect(concepts).toHaveLength(1);
    // The unit is named for its file, so qualifying it with the file it lives
    // in would only say "pond.json in pond.json".
    expect(concepts[0]?.title).toBe("pond.json");
  });

  it("keeps every changed line of a data file reachable", () => {
    // No trailing newline on either side, and edits on the first and last
    // lines, so a whole-file span that is off by one loses a changed line.
    const before = '{\n  "depth": 3,\n  "width": 8\n}';
    const after = '{\n  "depth": 4,\n  "width": 9\n}';
    const file: SourceFile = {
      path: "pond.json",
      content: after,
      previousContent: before,
      changeType: "modified",
    };
    const units = reviewUnits([file]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    validateConceptPartition(units, clusterReviewConcepts(units), [file]);

    expect(warn).not.toHaveBeenCalled();
    expect(units[0]).toMatchObject({ startLine: 1, endLine: 4 });
  });

  it("holds a sign-off through a reformat that changes no data", () => {
    const [signed] = reviewUnits([
      { path: "pond.json", content: manifest, changeType: "added" },
    ]);
    const [reformatted] = reviewUnits([
      {
        path: "pond.json",
        content: manifest.replaceAll("\n  ", "\n    "),
        changeType: "added",
      },
    ]);
    const [revalued] = reviewUnits([
      {
        path: "pond.json",
        content: manifest.replace('"1.2.0"', '"1.3.0"'),
        changeType: "added",
      },
    ]);

    expect(reformatted?.semanticHash).toBe(signed?.semanticHash);
    expect(revalued?.semanticHash).not.toBe(signed?.semanticHash);
  });

  it.each(dataDocuments)(
    "keeps a $language file whole when a revision only removes lines",
    ({ path, content }) => {
      // A deletion leaves no changed line on the current side, which is the
      // side diff scoping reads, so the file used to fall apart into anonymous
      // "Changed line 3" fragments precisely when nothing replaced the text.
      const lines = content.split("\n");
      const shortened = lines.filter((_, index) => index !== 2).join("\n");
      const units = reviewUnits([
        {
          path,
          content: shortened,
          previousContent: content,
          changeType: "modified",
        },
      ]);

      expect(units).toHaveLength(1);
      expect(units[0]).toMatchObject({
        name: path.split("/").at(-1),
        changeType: "modified",
      });
    },
  );

  it.each(dataDocuments)(
    "asks for no sign-off when a $language revision changed nothing",
    ({ path, content }) => {
      // A mode change, or a rebase that reports a file as touched, arrives as
      // a modification whose two sides are identical. Every other language
      // drops such a file in diff scoping, which a file reviewed whole skips.
      const units = reviewUnits([
        {
          path,
          content,
          previousContent: content,
          changeType: "modified",
        },
      ]);

      expect(units).toEqual([]);
    },
  );

  it("reviews a deleted data file as one unit", () => {
    const units = reviewUnits([
      {
        path: "pond.json",
        content: "",
        previousContent: manifest,
        changeType: "deleted",
      },
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      name: "pond.json",
      changeType: "deleted",
    });
  });

  it("reviews only data formats whole", () => {
    expect(
      languageAdapters
        .filter(({ reviewsWholeFile }) => reviewsWholeFile)
        .map(({ language }) => language)
        .sort(),
    ).toEqual(["json", "toml", "xml", "yaml"]);
  });

  it("still reviews markup section by section", () => {
    // Markup carries behaviour and prose that a reviewer judges separately, so
    // it must not be swept into the whole-file rule with the data formats.
    const units = reviewUnits([
      {
        path: "public/pond.html",
        content: [
          "<body>",
          "  <header><h1>Pond</h1></header>",
          "  <main><p>Ducks</p></main>",
          "  <script>const depth = 3;</script>",
          "</body>",
          "",
        ].join("\n"),
        changeType: "added",
      },
    ]);

    expect(units.length).toBeGreaterThan(1);
  });
});
