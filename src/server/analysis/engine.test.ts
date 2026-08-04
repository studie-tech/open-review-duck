import { describe, expect, it } from "vitest";
import { analyzeFiles, reconcileSignOffs } from "./engine";
import { applySourceBudget } from "./types";

describe("review analysis engine", () => {
  it("orders dependencies before their callers", () => {
    const result = analyzeFiles([
      {
        path: "math.ts",
        content:
          "export const double = (n: number) => n * 2;\nexport function total(n: number) { return double(n) + 1; }",
      },
    ]);
    expect(
      result.units
        .filter(({ kind }) => kind !== "file")
        .map((unit) => unit.name),
    ).toEqual(["double", "total"]);
    expect(result.units.find(({ kind }) => kind === "file")).toMatchObject({
      kind: "file",
      name: "math.ts",
    });
    expect(result.units.some(({ kind }) => kind === "module")).toBe(false);
  });

  it("finishes one independent concept branch before starting the next", () => {
    const result = analyzeFiles([
      {
        path: "features.ts",
        content: [
          "export const alphaLeaf = () => 1;",
          "export const betaLeaf = () => 2;",
          "export const alphaMiddle = () => alphaLeaf();",
          "export const betaMiddle = () => betaLeaf();",
          "export const alphaFeature = () => alphaMiddle();",
          "export const betaFeature = () => betaMiddle();",
        ].join("\n"),
      },
    ]);

    expect(
      result.units
        .filter(({ kind }) => kind !== "file")
        .map(({ name }) => name),
    ).toEqual([
      "alphaLeaf",
      "alphaMiddle",
      "alphaFeature",
      "betaLeaf",
      "betaMiddle",
      "betaFeature",
    ]);
  });

  it("clusters a removed binding with changed references in its lexical scope", () => {
    const previousContent = [
      "export function TravelPage() {",
      "  const [showBuildingLabels, setShowBuildingLabels] = useLocalStorage<boolean>('showBuildingLabels', false);",
      "  const toggleBuildingLabels = () => setShowBuildingLabels(!showBuildingLabels);",
      "  return showBuildingLabels ? <Map onClose={() => setShowBuildingLabels(false)} /> : null;",
      "}",
    ].join("\n");
    const content = [
      "export function TravelPage() {",
      "  return <Map />;",
      "}",
    ].join("\n");

    const units = analyzeFiles([
      {
        path: "app/travel/page.tsx",
        previousContent,
        content,
        changeType: "modified",
      },
    ]).units.filter(({ kind }) => kind !== "file");

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      name: expect.stringContaining("related changes"),
      relatedRanges: expect.arrayContaining([
        expect.objectContaining({ previousStartLine: 2 }),
      ]),
    });
    expect(units[0]?.previousSource).toContain("showBuildingLabels");
  });

  it("does not cluster unrelated changes that merely share a file", () => {
    const previousContent = [
      "export const alpha = () => 1;",
      "export const beta = () => 2;",
    ].join("\n");
    const content = [
      "export const alpha = () => 10;",
      "export const beta = () => 20;",
    ].join("\n");

    const units = analyzeFiles([
      {
        path: "independent.ts",
        previousContent,
        content,
        changeType: "modified",
      },
    ]).units.filter(({ kind }) => kind !== "file");

    expect(units).toHaveLength(2);
    expect(units.every(({ relatedRanges }) => !relatedRanges)).toBe(true);
  });

  it.each([
    {
      language: "TypeScript",
      path: "service.ts",
      previousContent:
        "export function helper() { return 1; }\nexport function run() { return helper(); }",
      content: "export function run() { return 0; }",
    },
    {
      language: "Python",
      path: "service.py",
      previousContent:
        "def helper():\n    return 1\n\ndef run():\n    return helper()\n",
      content: "def run():\n    return 0\n",
    },
    {
      language: "Java",
      path: "Service.java",
      previousContent:
        "class Service {\n  int helper() { return 1; }\n  int run() { return helper(); }\n}",
      content: "class Service {\n  int run() { return 0; }\n}",
    },
    {
      language: "Rust",
      path: "service.rs",
      previousContent: "fn helper() -> i32 { 1 }\nfn run() -> i32 { helper() }",
      content: "fn run() -> i32 { 0 }",
    },
  ])(
    "clusters definition/reference removal generically in $language",
    ({ path, previousContent, content }) => {
      const units = analyzeFiles([
        { path, previousContent, content, changeType: "modified" },
      ]).units.filter(({ kind }) => kind !== "file");

      expect(units).toHaveLength(1);
      expect(units[0]?.relatedRanges).toHaveLength(2);
      expect(units[0]?.name).toContain("related changes");
    },
  );

  it("carries the exact base range for repeated source text", () => {
    const previous = [
      "class First {",
      "  value() { return 1; }",
      "}",
      "",
      "class Second {",
      "  value() { return 1; }",
      "}",
    ].join("\n");
    const current = previous.replace(
      "class Second {\n  value() { return 1; }",
      "class Second {\n  value() { return 2; }",
    );

    const changed = analyzeFiles([
      {
        path: "repeated.ts",
        previousContent: previous,
        content: current,
        changeType: "modified",
      },
    ]).units.find(
      ({ kind, changeType }) => kind !== "file" && changeType === "modified",
    );

    expect(changed?.previousSource).toContain("value() { return 1; }");
    expect(changed?.previousStartLine).toBeGreaterThanOrEqual(5);
    expect(changed?.previousEndLine).toBeGreaterThanOrEqual(
      changed?.previousStartLine ?? 0,
    );
  });

  it("does not merge shadowed symbols across separate lexical scopes", () => {
    const previousContent = [
      "export function first() { const shared = 1; return shared; }",
      "export function second() { const shared = 2; return shared; }",
    ].join("\n");
    const content = [
      "export function first() { return 1; }",
      "export function second() { return 2; }",
    ].join("\n");

    const units = analyzeFiles([
      {
        path: "shadowed.ts",
        previousContent,
        content,
        changeType: "modified",
      },
    ]).units.filter(({ kind }) => kind !== "file");

    expect(units).toHaveLength(2);
    expect(units.every(({ relatedRanges }) => !relatedRanges)).toBe(true);
  });

  it("reviews independent schemas and data models before behavioral concepts", () => {
    const result = analyzeFiles([
      {
        path: "src/alpha.ts",
        content: "export function alphaUtility() { return 1; }",
      },
      {
        path: "src/models/user.ts",
        content: "export interface User { id: string; name: string; }",
      },
      {
        path: "src/zeta.ts",
        content: "export function zetaUtility() { return 2; }",
      },
    ]);

    expect(
      result.units
        .filter(({ kind }) => kind !== "file")
        .map(({ name }) => name),
    ).toEqual(["User", "alphaUtility", "zetaUtility"]);
  });

  it("keeps prerequisites ahead of a model while prioritizing its whole branch", () => {
    const result = analyzeFiles([
      {
        path: "src/alpha.ts",
        content: "export function alphaUtility() { return 1; }",
      },
      {
        path: "src/models/user.ts",
        content: [
          "export const identifier = () => 'user';",
          "export interface User { id: ReturnType<typeof identifier>; }",
          "export function loadUser() { return { id: identifier() } as User; }",
        ].join("\n"),
      },
    ]);

    const names = result.units
      .filter(({ kind }) => kind !== "file")
      .map(({ name }) => name);
    expect(names.indexOf("identifier")).toBeLessThan(names.indexOf("User"));
    expect(names.indexOf("User")).toBeLessThan(names.indexOf("loadUser"));
    expect(names.indexOf("loadUser")).toBeLessThan(
      names.indexOf("alphaUtility"),
    );
  });

  it("keeps full-file context out of the review queue when declarations cover it", () => {
    const result = analyzeFiles([
      {
        path: "errors.ts",
        content: [
          "/** Normalizes an execution error. */",
          "export function executionError() { return 'failed'; }",
          "/** Presents an execution error. */",
          "export function errorPresentation() { return executionError(); }",
        ].join("\n"),
      },
    ]);

    expect(
      result.units
        .filter(({ kind }) => kind !== "file")
        .map(({ name }) => name),
    ).toEqual(["executionError", "errorPresentation"]);
    expect(result.units.some(({ kind }) => kind === "module")).toBe(false);
    expect(result.units.find(({ kind }) => kind === "file")?.source).toContain(
      "errorPresentation",
    );
  });

  it("keeps import-only setup in file context instead of the review queue", () => {
    const result = analyzeFiles([
      {
        path: "service.ts",
        content: [
          '"use client";',
          'import { alpha, beta } from "./helpers";',
          "",
          "export function first() { return alpha(); }",
          "export function second() { return beta(); }",
        ].join("\n"),
      },
    ]);

    expect(
      result.units
        .filter(({ kind }) => kind !== "file")
        .map(({ name }) => name)
        .sort(),
    ).toEqual(["first", "second"]);
    expect(result.units.find(({ kind }) => kind === "file")?.source).toContain(
      'import { alpha, beta } from "./helpers";',
    );

    const importsOnly = analyzeFiles([
      {
        path: "dependencies.ts",
        content: 'import type { Config } from "./config";',
      },
    ]);
    expect(
      importsOnly.units.filter(({ kind }) => kind !== "file"),
    ).toHaveLength(0);
  });

  it("shows imports as context for individual tests instead of separate setup units", () => {
    const result = analyzeFiles([
      {
        path: "helper.test.ts",
        content: [
          'import { describe, expect, it } from "vitest";',
          'import { helper } from "./helper";',
          "",
          'it("uses the helper", () => {',
          "  expect(helper()).toBe(true);",
          "});",
        ].join("\n"),
        changeType: "added",
      },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    expect(reviewable).toHaveLength(1);
    expect(reviewable[0]).toMatchObject({
      kind: "test",
      name: "uses the helper",
    });
    expect(result.units.find(({ kind }) => kind === "file")?.source).toContain(
      'import { helper } from "./helper";',
    );
  });

  it("keeps local variables inside their enclosing function unit", () => {
    const result = analyzeFiles([
      {
        path: "waiting.ts",
        content: [
          "export function hasNewActivity(previouslyObservedCommentIds: string[]) {",
          "  const observed = new Set(previouslyObservedCommentIds);",
          "  return !observed.has('new-comment');",
          "}",
        ].join("\n"),
      },
    ]);

    expect(result.units.map(({ name }) => name)).not.toContain("observed");
    expect(
      result.units.find(({ name }) => name === "hasNewActivity"),
    ).toMatchObject({
      startLine: 1,
      endLine: 4,
      source: expect.stringContaining("previouslyObservedCommentIds: string[]"),
    });
  });

  it("includes JSDoc and export syntax in the documented declaration unit", () => {
    const result = analyzeFiles([
      {
        path: "hash.ts",
        content: [
          "/** Extracts the semantic token stream used to hash a code unit. */",
          "export function tokenStream(source: string) {",
          "  return source.trim();",
          "}",
        ].join("\n"),
      },
    ]);

    expect(
      result.units.find(({ name }) => name === "tokenStream"),
    ).toMatchObject({
      startLine: 1,
      endLine: 4,
      signature: "export function tokenStream(source: string)",
      source: [
        "/** Extracts the semantic token stream used to hash a code unit. */",
        "export function tokenStream(source: string) {",
        "  return source.trim();",
        "}",
      ].join("\n"),
    });
  });

  it("does not attach an ordinary block comment to a declaration unit", () => {
    const result = analyzeFiles([
      {
        path: "hash.ts",
        content: [
          "/* This describes the module rather than the declaration. */",
          "function tokenStream(source: string) {",
          "  return source.trim();",
          "}",
        ].join("\n"),
      },
    ]);

    expect(
      result.units.find(({ name }) => name === "tokenStream"),
    ).toMatchObject({
      startLine: 2,
      source: expect.not.stringContaining("describes the module"),
    });
  });

  it("keeps adjacent exported TSX functions in separate review units", () => {
    const result = analyzeFiles([
      {
        path: "indicator.tsx",
        content: [
          "/** Renders the current shortcut sequence. */",
          "export function ShortcutSequenceIndicator() {",
          "  return (",
          '    <div className="panel">',
          '      <span>{true ? `Ready` : "Waiting"}</span>',
          "    </div>",
          "  );",
          "}",
          "/** Renders the command palette. */",
          "export function CommandCenter() { return null; }",
        ].join("\n"),
      },
    ]);

    expect(
      result.units.find(({ name }) => name === "ShortcutSequenceIndicator"),
    ).toMatchObject({ startLine: 1, endLine: 8 });
    expect(
      result.units.find(({ name }) => name === "CommandCenter"),
    ).toMatchObject({ startLine: 9, endLine: 10 });
  });

  it("still extracts exported and module-level constants", () => {
    const result = analyzeFiles([
      {
        path: "config.ts",
        content: [
          "export const PUBLIC_LIMIT = 10;",
          "const INTERNAL_LIMIT = 5;",
        ].join("\n"),
      },
    ]);

    const constants = result.units
      .filter(({ kind }) => kind === "constant")
      .map(({ name }) => name);
    expect(constants).toHaveLength(2);
    expect(constants).toEqual(
      expect.arrayContaining(["PUBLIC_LIMIT", "INTERNAL_LIMIT"]),
    );
  });

  it("supports Python and revisits changed review documentation", () => {
    const before = analyzeFiles([
      { path: "math.py", content: "def total(n):\n    return n + 1\n" },
    ]).units;
    const after = analyzeFiles([
      {
        path: "math.py",
        content: "def total(n):\n    # explanation\n    return n + 1\n",
      },
    ]).units;
    expect(before).toHaveLength(2);
    expect(
      reconcileSignOffs(before, after).every(
        ({ requiresReview }) => requiresReview,
      ),
    ).toBe(true);
  });

  it("invalidates a sign-off when executable semantics change", () => {
    const before = analyzeFiles([
      {
        path: "math.ts",
        content: "function total(n: number) { return n + 1 }",
      },
    ]).units;
    const after = analyzeFiles([
      {
        path: "math.ts",
        content: "function total(n: number) { return n + 2 }",
      },
    ]).units;
    expect(reconcileSignOffs(before, after)[0]?.requiresReview).toBe(true);
  });

  it("preserves meaningful whitespace and comment markers inside literals", () => {
    const before = analyzeFiles([
      {
        path: "message.ts",
        content: 'const message = "review // ready";',
      },
    ]).units;
    const after = analyzeFiles([
      {
        path: "message.ts",
        content: 'const message = "review  // ready";',
      },
    ]).units;

    expect(
      reconcileSignOffs(before, after).every(
        ({ requiresReview }) => requiresReview,
      ),
    ).toBe(true);
  });

  it("ignores formatting-only trivia outside syntax tokens", () => {
    const before = analyzeFiles([
      { path: "math.ts", content: "const total=(value:number)=>value+1;" },
    ]).units;
    const after = analyzeFiles([
      {
        path: "math.ts",
        content: "const total = (value: number) => value + 1;",
      },
    ]).units;

    expect(
      reconcileSignOffs(before, after).every(
        ({ requiresReview }) => !requiresReview,
      ),
    ).toBe(true);
  });

  it("invalidates unchanged callers when a dependency changes", () => {
    const before = analyzeFiles([
      {
        path: "math.ts",
        content:
          "function double(n: number) { return n * 2 }\nfunction total(n: number) { return double(n) + 1 }",
      },
    ]).units;
    const after = analyzeFiles([
      {
        path: "math.ts",
        content:
          "function double(n: number) { return n * 3 }\nfunction total(n: number) { return double(n) + 1 }",
      },
    ]).units;
    const impact = reconcileSignOffs(before, after);
    expect(
      impact.find(({ unit }) => unit.name === "double")?.requiresReview,
    ).toBe(true);
    expect(
      impact.find(({ unit }) => unit.name === "total")?.requiresReview,
    ).toBe(true);
  });

  it("propagates changed constants to unchanged consumers", () => {
    const before = analyzeFiles([
      {
        path: "retry.ts",
        content:
          "const MAX_RETRIES = 3;\nfunction shouldRetry(attempt: number) { return attempt < MAX_RETRIES }",
      },
    ]).units;
    const after = analyzeFiles([
      {
        path: "retry.ts",
        content:
          "const MAX_RETRIES = 5;\nfunction shouldRetry(attempt: number) { return attempt < MAX_RETRIES }",
      },
    ]).units;

    const impact = reconcileSignOffs(before, after);
    expect(
      impact.find(({ unit }) => unit.name === "shouldRetry")?.requiresReview,
    ).toBe(true);
  });

  it("resolves uniquely named dependencies across files", () => {
    const result = analyzeFiles([
      {
        path: "utils.ts",
        content:
          "export function normalize(value: string) { return value.trim() }",
      },
      {
        path: "service.ts",
        content:
          "export function save(value: string) { return normalize(value) }",
      },
    ]);
    const normalize = result.units.find(({ name }) => name === "normalize");
    const save = result.units.find(({ name }) => name === "save");
    expect(save?.dependencies).toContain(normalize?.stableKey);
    expect(save?.reviewOrder).toBeGreaterThan(normalize?.reviewOrder ?? -1);
  });

  it("resolves aliased imports even when exported names are duplicated", () => {
    const result = analyzeFiles([
      {
        path: "first/normalize.ts",
        content:
          "export function normalize(value: string) { return value.trim() }",
      },
      {
        path: "second/normalize.ts",
        content:
          "export function normalize(value: string) { return value.toLowerCase() }",
      },
      {
        path: "service.ts",
        content: [
          'import { normalize as clean } from "./first/normalize";',
          "export function save(value: string) { return clean(value) }",
        ].join("\n"),
      },
    ]);
    const firstNormalize = result.units.find(
      ({ path, name }) => path === "first/normalize.ts" && name === "normalize",
    );
    const save = result.units.find(({ name }) => name === "save");

    expect(save?.dependencies).toContain(firstNormalize?.stableKey);
  });

  it("stores one dependency edge when multiple imports resolve to one unit", () => {
    const result = analyzeFiles([
      {
        path: "normalize.ts",
        content:
          "export function normalize(value: string) { return value.trim() }",
      },
      {
        path: "service.ts",
        content: [
          'import { normalize, normalize as clean } from "./normalize";',
          "export function save(value: string) { return normalize(clean(value)) }",
        ].join("\n"),
      },
    ]);
    const normalize = result.units.find(
      ({ path, name }) => path === "normalize.ts" && name === "normalize",
    );
    const save = result.units.find(({ name }) => name === "save");

    expect(
      save?.dependencies.filter(
        (dependency) => dependency === normalize?.stableKey,
      ),
    ).toHaveLength(1);
  });

  it("resolves Python import aliases", () => {
    const result = analyzeFiles([
      {
        path: "utils.py",
        content: "def normalize(value):\n    return value.strip()\n",
      },
      {
        path: "service.py",
        content:
          "from utils import normalize as clean\n\ndef save(value):\n    return clean(value)\n",
      },
    ]);
    const normalize = result.units.find(
      ({ path, name }) => path === "utils.py" && name === "normalize",
    );
    const save = result.units.find(({ name }) => name === "save");

    expect(save?.dependencies).toContain(normalize?.stableKey);
  });

  it("does not create self-dependencies from declaration signatures", () => {
    const unit = analyzeFiles([
      {
        path: "math.ts",
        content: "export function double(n: number) { return n * 2 }",
      },
    ]).units.find(({ kind }) => kind === "function");

    expect(unit?.dependencies).toEqual([]);
    expect(unit?.depth).toBe(0);
  });

  it("uses scoped stable keys for methods with the same name", () => {
    const result = analyzeFiles([
      {
        path: "services.ts",
        content: [
          "class UserService { save() { return true } }",
          "class TeamService { save() { return false } }",
        ].join("\n"),
      },
    ]);
    const saveMethods = result.units.filter(({ name }) => name === "save");

    expect(saveMethods).toHaveLength(2);
    expect(new Set(saveMethods.map(({ stableKey }) => stableKey)).size).toBe(2);
    expect(saveMethods.map(({ stableKey }) => stableKey)).toEqual(
      expect.arrayContaining([
        "services.ts:method:UserService.save",
        "services.ts:method:TeamService.save",
      ]),
    );
  });

  it("gives TypeScript overload declarations collision-free identities", () => {
    const result = analyzeFiles([
      {
        path: "format.ts",
        content: [
          "function format(value: string): string;",
          "function format(value: number): string;",
          "function format(value: string | number) { return String(value) }",
        ].join("\n"),
      },
    ]);
    const overloads = result.units.filter(
      ({ name, kind }) => name === "format" && kind === "function",
    );

    expect(overloads).toHaveLength(3);
    expect(new Set(overloads.map(({ stableKey }) => stableKey)).size).toBe(3);
  });

  it("invalidates former callers when a signed-off dependency is deleted", () => {
    const before = analyzeFiles([
      {
        path: "math.ts",
        content: [
          "function double(n: number) { return n * 2 }",
          "function total(n: number) { return double(n) + 1 }",
        ].join("\n"),
      },
    ]).units;
    const after = analyzeFiles([
      {
        path: "math.ts",
        content: "function total(n: number) { return double(n) + 1 }",
      },
    ]).units;

    expect(
      reconcileSignOffs(before, after).find(({ unit }) => unit.name === "total")
        ?.requiresReview,
    ).toBe(true);
  });

  it("classifies Python class members as methods", () => {
    const result = analyzeFiles([
      {
        path: "service.py",
        content: "class Service:\n    def save(self):\n        return True\n",
      },
    ]);

    expect(result.units.find(({ name }) => name === "save")).toMatchObject({
      kind: "method",
      stableKey: "service.py:method:Service.save",
    });
  });

  it("makes module-level changes reviewable after their declarations", () => {
    const before = analyzeFiles([
      {
        path: "bootstrap.ts",
        content:
          "const port = 3000;\nfunction start() { return port }\nstart();",
      },
    ]).units;
    const after = analyzeFiles([
      {
        path: "bootstrap.ts",
        content:
          "const port = 3000;\nfunction start() { return port }\nstart();\nconsole.log('ready');",
      },
    ]).units;
    const impact = reconcileSignOffs(before, after);

    expect(
      impact.find(({ unit }) => unit.kind === "constant")?.requiresReview,
    ).toBe(false);
    expect(
      impact.find(({ unit }) => unit.kind === "function")?.requiresReview,
    ).toBe(false);
    expect(
      impact.find(({ unit }) => unit.kind === "module")?.requiresReview,
    ).toBe(true);
    expect(after.find(({ kind }) => kind === "module")).toMatchObject({
      name: "Module statements",
      startLine: 3,
      source: expect.stringContaining("console.log('ready')"),
    });
    expect(after.filter(({ kind }) => kind !== "file").at(-1)?.kind).toBe(
      "module",
    );
  });

  it("never carries sign-offs when unchanged source is deleted", () => {
    const before = analyzeFiles([
      {
        path: "legacy.ts",
        content: "export function legacy() { return true }",
        changeType: "modified",
      },
    ]).units;
    const after = analyzeFiles([
      {
        path: "legacy.ts",
        content: "export function legacy() { return true }",
        changeType: "deleted",
      },
    ]).units;

    expect(
      reconcileSignOffs(before, after).every(
        ({ requiresReview }) => requiresReview,
      ),
    ).toBe(true);
    expect(after.every(({ changeType }) => changeType === "deleted")).toBe(
      true,
    );
  });

  it("retains base-revision file context without duplicating every symbol", () => {
    const current = "export const total = () => 2;";
    const previous = "export const total = () => 1;";
    const result = analyzeFiles([
      {
        path: "total.ts",
        content: current,
        previousContent: previous,
      },
    ]);

    expect(
      result.units.find(({ kind }) => kind === "file")?.previousSource,
    ).toBe(previous);
    expect(
      result.units.find(({ kind }) => kind !== "file")?.previousSource,
    ).toBeUndefined();
  });

  it("only creates sign-off units for declarations changed by the pull request", () => {
    const previous = `import { z } from "zod";
/** Global travel accepts only the target sector. */
export const startGlobalMoveSchema = z.object({ sector: z.number() }).strict();
export const quickTravelSchema = z.object({ sector: z.number() });`;
    const current = `import { z } from "zod";
/** Global travel also accepts the previously observed sector. */
export const startGlobalMoveSchema = z
  .object({ sector: z.number(), currentSector: z.number().optional() })
  .strict().transform(({ sector }) => ({ sector }));
export const quickTravelSchema = z.object({ sector: z.number() });`;
    const result = analyzeFiles([
      {
        path: "app/src/validators/travel.ts",
        content: current,
        previousContent: previous,
        changeType: "modified",
      },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    const schemaUnits = reviewable.filter(
      ({ name }) => name === "startGlobalMoveSchema",
    );
    expect(schemaUnits).toHaveLength(1);
    expect(schemaUnits[0]).toMatchObject({
      changeType: "modified",
      kind: "constant",
    });
    expect(schemaUnits[0]?.previousSource).toContain(
      "Global travel accepts only the target sector",
    );
    expect(schemaUnits[0]?.source).toContain(
      "Global travel also accepts the previously observed sector",
    );
    expect(reviewable.some(({ name }) => name === "quickTravelSchema")).toBe(
      false,
    );
    expect(result.units.find(({ kind }) => kind === "file")?.source).toContain(
      "quickTravelSchema",
    );
  });

  it.each([
    {
      language: "TypeScript",
      path: "service.ts",
      previous: "export function oldName() { return 1; }",
      current: "export function newName() { return 2; }",
      name: "newName",
    },
    {
      language: "Python",
      path: "service.py",
      previous: "def old_name():\n    return 1",
      current: "def new_name():\n    return 2",
      name: "new_name",
    },
  ])(
    "pairs a renamed $language declaration as one modified unit",
    ({ path, previous, current, name }) => {
      const result = analyzeFiles([
        {
          path,
          content: current,
          previousContent: previous,
          changeType: "modified",
        },
      ]);
      const reviewable = result.units.filter(({ kind }) => kind !== "file");

      expect(reviewable).toHaveLength(1);
      expect(reviewable[0]).toMatchObject({
        name,
        changeType: "modified",
        previousSource: previous,
      });
    },
  );

  it("keeps generic TypeScript arrow declarations isolated around an insertion", () => {
    const random =
      "export const getRandomElement = <T>(arr?: readonly T[]) => arr?.[0];";
    const membership =
      "export const isInArray = <T, A extends T>(item: T, array: ReadonlyArray<A>): item is A => array.includes(item as A);";
    const common =
      "export const getMostCommonElement = <T extends string>(arr: T[]) => arr[0];";
    const inserted =
      "export const chunkArray = <T>(values: readonly T[], size: number): T[][] => [values.slice(0, size)];";
    const previous = [random, membership, common].join("\n");
    const current = [random, inserted, membership, common].join("\n");
    const result = analyzeFiles([
      {
        path: "app/src/utils/array.ts",
        content: current,
        previousContent: previous,
        changeType: "modified",
      },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    expect(reviewable).toHaveLength(1);
    expect(reviewable[0]).toMatchObject({
      name: "chunkArray",
      kind: "function",
      changeType: "added",
      startLine: 2,
      endLine: 2,
    });
    expect(reviewable[0]?.source).toContain("export const chunkArray");
    expect(reviewable[0]?.source).not.toContain("getRandomElement");
    expect(reviewable[0]?.source).not.toContain("isInArray");
    expect(reviewable[0]?.source).not.toContain("getMostCommonElement");
  });

  it("marks a declaration absent from the base revision as entirely added", () => {
    const previous = [
      "export const existing = () => true;",
      "export const after = () => false;",
    ].join("\n");
    const addedFunction = `/** Checks the shared limiter. */
export async function checkProcedureRateLimit(path: string) {
  try {
    return await limit(path);
  } catch {
    return true;
  }
}`;
    const current = [
      "export const existing = () => true;",
      addedFunction,
      "export const after = () => false;",
    ].join("\n");
    const result = analyzeFiles([
      {
        path: "src/server/api/trpc.ts",
        content: current,
        previousContent: previous,
        changeType: "modified",
      },
    ]);

    expect(
      result.units.find(({ name }) => name === "checkProcedureRateLimit"),
    ).toMatchObject({
      changeType: "added",
      previousSource: undefined,
      source: addedFunction,
    });
  });

  it("does not invent deleted units when an earlier addition only shifts unchanged code", () => {
    const unchangedFunction = `/** Checks if an item is in the array. */
export const isInArray = <T, A extends T>(
  item: T,
  array: ReadonlyArray<A>,
): item is A => {
  return array.includes(item as A);
};`;
    const previous = [
      "export const existing = () => true;",
      unchangedFunction,
      "export const after = () => false;",
    ].join("\n\n");
    const addedFunction = `/** Splits an array into bounded batches. */
export const chunkArray = <T>(values: readonly T[], batchSize: number): T[][] => {
  const batches: T[][] = [];
  return batches;
};`;
    const current = [
      "export const existing = () => true;",
      addedFunction,
      unchangedFunction,
      "export const after = () => false;",
    ].join("\n\n");

    const result = analyzeFiles([
      {
        path: "src/utils/array.ts",
        content: current,
        previousContent: previous,
        changeType: "modified",
      },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    expect(reviewable.map(({ name }) => name)).toEqual(["chunkArray"]);
    expect(reviewable.find(({ name }) => name === "chunkArray")).toMatchObject({
      changeType: "added",
    });
  });

  it("folds a changed import into the logical unit that uses it", () => {
    const previous = [
      'import { procedure } from "./trpc";',
      "export const route = procedure.query(() => true);",
    ].join("\n");
    const current = [
      'import { procedure, rateLimit } from "./trpc";',
      "export const route = procedure.use(rateLimit).query(() => true);",
    ].join("\n");
    const result = analyzeFiles([
      {
        path: "route.ts",
        content: current,
        previousContent: previous,
        changeType: "modified",
      },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    expect(reviewable).toMatchObject([
      {
        name: "route",
        source:
          "export const route = procedure.use(rateLimit).query(() => true);",
      },
    ]);
    expect(reviewable.some(({ name }) => name.startsWith("Changed "))).toBe(
      false,
    );
  });

  it("pairs a rewritten import as one modified change unit", () => {
    const previous = [
      'import NotFoundPage from "@/app/[...not-found]/page";',
      'import { FORUM_MIN_LEVEL } from "@/drizzle/constants";',
      "export function Page() { return NotFoundPage({}); }",
    ].join("\n");
    const current = [
      'import NotFoundPage from "@/components/layout/NotFoundPage";',
      'import { FORUM_MIN_LEVEL } from "@/drizzle/constants";',
      "export function Page() { return NotFoundPage({}); }",
    ].join("\n");
    const result = analyzeFiles([
      {
        path: "page.tsx",
        content: current,
        previousContent: previous,
        changeType: "modified",
      },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    expect(reviewable).toMatchObject([
      {
        name: "Changed line 1",
        changeType: "modified",
        source: 'import NotFoundPage from "@/components/layout/NotFoundPage";',
        previousSource: 'import NotFoundPage from "@/app/[...not-found]/page";',
      },
    ]);
  });

  it("focuses an oversized router on the changed property", () => {
    const padding = Array.from(
      { length: 125 },
      (_, index) => `  route${index}: procedure.query(() => ${index}),`,
    );
    /** Builds the same oversized router with optional changed middleware. */
    const router = (rateLimited: boolean) =>
      [
        rateLimited
          ? 'import { procedure, rateLimit } from "./trpc";'
          : 'import { procedure } from "./trpc";',
        "",
        "export const itemRouter = createRouter({",
        ...padding,
        "  // Split item stack",
        "  splitStack: procedure",
        ...(rateLimited ? ["    .use(rateLimit)"] : []),
        "    .query(() => true),",
        "});",
      ].join("\n");
    const result = analyzeFiles([
      {
        path: "item.ts",
        content: router(true),
        previousContent: router(false),
        changeType: "modified",
      },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    expect(reviewable).toHaveLength(1);
    expect(reviewable[0]).toMatchObject({
      name: "itemRouter › splitStack",
      kind: "method",
      changeType: "modified",
    });
    expect(reviewable[0]?.source).toContain("// Split item stack");
    expect(reviewable[0]?.source).toContain(".use(rateLimit)");
    expect(reviewable[0]?.source).not.toContain("route124");
  });

  it("focuses an oversized component on its changed hook", () => {
    const padding = Array.from(
      { length: 125 },
      (_, index) => `  const value${index} = ${index};`,
    );
    /** Builds the same oversized component with optional authentication logic. */
    const component = (authenticated: boolean) =>
      [
        "export const Conversation = () => {",
        ...padding,
        "  // Send typing indicator when user types",
        "  useEffect(() => {",
        ...(authenticated ? ["    if (!userId) return;"] : []),
        "    sendTypingIndicator();",
        authenticated
          ? "  }, [sendTypingIndicator, userId]);"
          : "  }, [sendTypingIndicator]);",
        "  return null;",
        "};",
      ].join("\n");
    const result = analyzeFiles([
      {
        path: "Conversation.tsx",
        content: component(true),
        previousContent: component(false),
        changeType: "modified",
      },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    expect(reviewable).toHaveLength(1);
    expect(reviewable[0]).toMatchObject({
      name: "Conversation › useEffect › Send typing indicator when user types",
      kind: "method",
      changeType: "modified",
    });
    expect(reviewable[0]?.source).toContain("if (!userId) return;");
    expect(reviewable[0]?.source).not.toContain("value124");
  });

  it("prefers a changed nested method over its unchanged TypeScript class shell", () => {
    /** Builds a class whose method body changes without changing its shell. */
    const source = (result: string) =>
      [
        "export class Service {",
        `  run() { return ${result}; }`,
        "  untouched() { return true; }",
        "}",
      ].join("\n");
    const result = analyzeFiles([
      {
        path: "service.ts",
        content: source("2"),
        previousContent: source("1"),
        changeType: "modified",
      },
    ]);

    expect(
      result.units
        .filter(({ kind }) => kind !== "file")
        .map(({ name }) => name),
    ).toEqual(["run"]);
  });

  it("keeps changed imports and deleted declarations in explicit coverage units", () => {
    const previous = [
      'import { oldHelper } from "./helper";',
      "export const removed = () => oldHelper();",
      "export const kept = () => 1;",
    ].join("\n");
    const current = [
      'import { newHelper } from "./helper";',
      "export const kept = () => 1;",
    ].join("\n");
    const result = analyzeFiles([
      {
        path: "changes.ts",
        content: current,
        previousContent: previous,
        changeType: "modified",
      },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    expect(reviewable.some(({ source }) => source.includes("newHelper"))).toBe(
      true,
    );
    expect(
      reviewable.some(
        ({ name, changeType, source }) =>
          name === "removed" &&
          changeType === "deleted" &&
          source.includes("oldHelper"),
      ),
    ).toBe(true);
    expect(reviewable.some(({ name }) => name === "kept")).toBe(false);
  });

  it("invalidates a signed unit when its contextual import target changes", () => {
    const base = [
      'import { safeExec } from "./safe";',
      "export function run(input: string) { return safeExec(input); }",
    ].join("\n");
    /** Builds a PR revision that keeps the body change while retargeting its import. */
    const head = (specifier: string) =>
      [
        `import { safeExec } from "${specifier}";`,
        "export function run(input: string) { return safeExec(input) + '!'; }",
      ].join("\n");
    const before = analyzeFiles([
      {
        path: "runner.ts",
        content: head("./safe"),
        previousContent: base,
        changeType: "modified",
      },
    ]).units;
    const after = analyzeFiles([
      {
        path: "runner.ts",
        content: head("./unsafe"),
        previousContent: base,
        changeType: "modified",
      },
    ]).units;

    expect(
      reconcileSignOffs(before, after).find(({ unit }) => unit.name === "run")
        ?.requiresReview,
    ).toBe(true);
  });

  it("keeps an added import-only file in the sign-off path", () => {
    const result = analyzeFiles([
      {
        path: "exports.ts",
        content: 'export { review } from "./review";',
        changeType: "added",
      },
    ]);

    expect(result.units.filter(({ kind }) => kind !== "file")).toMatchObject([
      {
        name: "exports.ts",
        source: 'export { review } from "./review";',
      },
    ]);
  });

  it("reviews documentation-only edits with their declaration", () => {
    const result = analyzeFiles([
      {
        path: "documented.ts",
        previousContent:
          "/** Returns the configured port. */\nexport function port() { return 3666; }",
        content:
          "/** Returns the local ReviewDuck port. */\nexport function port() { return 3666; }",
        changeType: "modified",
      },
    ]);

    expect(result.units.filter(({ kind }) => kind !== "file")).toMatchObject([
      {
        name: "port",
        previousSource: expect.stringContaining("configured port"),
        source: expect.stringContaining("local ReviewDuck port"),
      },
    ]);
  });

  it("keeps unparsed text files in the review as complete file units", () => {
    const result = analyzeFiles([
      {
        path: "config/settings.ini",
        content: "[review]\nenabled=true\nlimit=5",
        changeType: "added",
      },
    ]);

    expect(result.unsupportedFiles).toEqual([]);
    expect(result.units.find(({ kind }) => kind !== "file")).toMatchObject({
      language: "text",
      kind: "module",
      name: "settings.ini",
      source: expect.stringContaining("enabled=true"),
    });
  });

  it("represents binary changes without retaining or displaying their bytes", () => {
    const result = analyzeFiles([
      {
        path: "assets/logo.png",
        content: "\0private-binary-bytes",
        isBinary: true,
        binaryHash: "blob-123",
        changeType: "modified",
      },
    ]);
    const binary = result.units.find(({ kind }) => kind === "binary");

    expect(result.unsupportedFiles).toEqual([]);
    expect(binary).toMatchObject({
      language: "text",
      name: "logo.png",
      source: "Binary file — content is not displayed.",
    });
    expect(
      result.units.every(({ source }) => !source.includes("private")),
    ).toBe(true);
  });

  it("keeps an explicit review-path notice for oversized files", () => {
    const result = analyzeFiles([
      {
        path: "generated/schema.json",
        content: "",
        skipReason: "too_large",
        binaryHash: "revision-7:schema",
        changeType: "modified",
      },
    ]);

    expect(result.unsupportedFiles).toEqual(["generated/schema.json"]);
    expect(result.units.find(({ kind }) => kind !== "file")).toMatchObject({
      language: "text",
      kind: "module",
      source: "File content is too large to display safely.",
    });
  });

  it("bounds aggregate source retained for very large pull requests", () => {
    const files = applySourceBudget(
      [
        { path: "one.ts", content: "12345" },
        { path: "two.ts", content: "67890" },
      ],
      7,
    );

    expect(files[0]?.skipReason).toBeUndefined();
    expect(files[1]).toMatchObject({ content: "", skipReason: "too_large" });
  });
});
