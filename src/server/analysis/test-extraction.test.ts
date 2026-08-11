import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeFiles, reconcileSignOffs } from "./engine";

describe("test unit extraction", () => {
  it("splits the real analysis test suite into focused review units", () => {
    const source = readFileSync(new URL("./engine.test.ts", import.meta.url), {
      encoding: "utf8",
    });
    const result = analyzeFiles([
      { path: "src/server/analysis/engine.test.ts", content: source },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    expect(
      reviewable.filter(({ kind }) => kind === "test").length,
    ).toBeGreaterThan(20);
    expect(reviewable.some(({ kind }) => kind === "test_suite")).toBe(false);
    expect(reviewable.find(({ name }) => name === "Test setup")).toMatchObject({
      startLine: 1,
      endLine: 5,
    });
    expect(result.units.some(({ kind }) => kind === "file")).toBe(true);
    expect(
      Math.max(...reviewable.map((unit) => unit.endLine - unit.startLine + 1)),
    ).toBeLessThan(50);
  });

  it("does not expose later suite headers as one-line review units", () => {
    const source = readFileSync(
      new URL("../../lib/review-navigation.test.ts", import.meta.url),
      { encoding: "utf8" },
    );
    const result = analyzeFiles([
      { path: "src/lib/review-navigation.test.ts", content: source },
    ]);

    expect(result.units.some(({ kind }) => kind === "test_suite")).toBe(false);
    const setup = result.units.find(({ name }) => name === "Test setup");
    expect(setup).toMatchObject({
      startLine: 1,
      source: expect.stringContaining('describe("nextPendingReviewIndex"'),
    });
    const laterSuiteLine = source
      .split("\n")
      .findIndex(
        (line, index) =>
          index >= (setup?.endLine ?? 0) && line.startsWith("describe("),
      );
    expect(laterSuiteLine).toBeGreaterThan(0);
    expect(setup?.endLine).toBeLessThan(laterSuiteLine + 1);
    expect(
      result.units.find(
        ({ name }) =>
          name ===
          "reviewPathSections › anchors the current unit without rotating the planned review order",
      ),
    ).toMatchObject({
      kind: "test",
      source: expect.stringContaining(
        'it("anchors the current unit without rotating the planned review order"',
      ),
    });
  });

  it("uses suites as test metadata and combines the first header with setup", () => {
    const result = analyzeFiles([
      {
        path: "src/math.test.ts",
        content: [
          'import { beforeEach, describe, expect, it, test } from "vitest";',
          'import { total } from "./math";',
          "",
          'describe("math", () => {',
          "  beforeEach(() => reset());",
          '  it("adds values", () => expect(total(1, 2)).toBe(3));',
          '  test.each([[1, 2, 3]])("adds %s and %s", (a, b, sum) => {',
          "    expect(total(a, b)).toBe(sum);",
          "  });",
          '  test.todo("handles overflow");',
          "});",
        ].join("\n"),
      },
    ]);

    expect(
      result.units
        .filter(({ kind }) => kind === "test")
        .map(({ name }) => name),
    ).toEqual([
      "math › adds values",
      "math › adds %s and %s",
      "math › handles overflow",
    ]);
    expect(result.units.find(({ kind }) => kind === "test_hook")).toMatchObject(
      { name: "math › before each", startLine: 5, endLine: 5 },
    );
    expect(result.units.some(({ kind }) => kind === "test_suite")).toBe(false);
    expect(result.units.find(({ kind }) => kind === "file")).toMatchObject({
      startLine: 1,
      endLine: 11,
      source: expect.stringContaining('it("adds values"'),
    });
    expect(
      result.units.find(({ name }) => name === "Test setup"),
    ).toMatchObject({
      kind: "module",
      startLine: 1,
      endLine: 4,
    });
  });

  it("folds file directives and lightweight lifecycle registration into setup", () => {
    const result = analyzeFiles([
      {
        path: "src/view.test.tsx",
        content: [
          `// @vitest-${"environment"} jsdom`,
          "",
          'import { cleanup } from "@testing-library/react";',
          'import { afterEach, describe, it } from "vitest";',
          "",
          "afterEach(cleanup);",
          "",
          'describe("view", () => {',
          '  it("renders", () => renderView());',
          "});",
        ].join("\n"),
      },
    ]);

    expect(
      result.units.find(({ name }) => name === "Test setup"),
    ).toMatchObject({
      startLine: 1,
      endLine: 8,
      source: expect.stringContaining("afterEach(cleanup)"),
    });
    expect(
      result.units.some(({ name }) => name === "afterEach(cleanup);"),
    ).toBe(false);
  });

  it("groups adjacent lifecycle registrations after test fixtures", () => {
    const result = analyzeFiles([
      {
        path: "src/theme.test.tsx",
        content: [
          'import { afterEach, beforeEach, describe, it } from "vitest";',
          "const listeners = new Set<() => void>();",
          "",
          "beforeEach(() => {",
          "  listeners.clear();",
          "});",
          "afterEach(cleanup);",
          'describe("theme", () => {',
          '  it("renders", () => renderTheme());',
          "});",
        ].join("\n"),
      },
    ]);

    expect(
      result.units.find(({ name }) => name === "Test lifecycle"),
    ).toMatchObject({
      kind: "test_hook",
      startLine: 4,
      endLine: 7,
      source: expect.stringContaining("afterEach(cleanup)"),
    });
    expect(
      result.units.some(({ name }) => name === "afterEach(cleanup);"),
    ).toBe(false);
  });

  it("keeps test imports in file context and the tests adjacent", () => {
    const result = analyzeFiles([
      {
        path: "src/alpha.test.ts",
        content: [
          'import { it } from "vitest";',
          'it("alpha one", () => alpha());',
          'it("alpha two", () => alpha());',
        ].join("\n"),
      },
      {
        path: "src/beta.test.ts",
        content: [
          'import { it } from "vitest";',
          'it("beta one", () => beta());',
        ].join("\n"),
      },
    ]);
    const reviewable = result.units.filter(({ kind }) => kind !== "file");

    expect(
      reviewable
        .filter(({ path }) => path === "src/alpha.test.ts")
        .map(({ name }) => name),
    ).toEqual(["alpha one", "alpha two"]);
    expect(
      reviewable
        .filter(({ path }) => path === "src/beta.test.ts")
        .map(({ name }) => name),
    ).toEqual(["beta one"]);
    expect(
      result.units.find(
        ({ path, kind }) => path === "src/alpha.test.ts" && kind === "file",
      )?.source,
    ).toContain('import { it } from "vitest";');
    const alphaIndexes = reviewable.flatMap((unit, index) =>
      unit.path === "src/alpha.test.ts" ? [index] : [],
    );
    expect(Math.max(...alphaIndexes) - Math.min(...alphaIndexes)).toBe(
      alphaIndexes.length - 1,
    );
  });

  it("recognizes aliased framework imports outside conventional test paths", () => {
    const result = analyzeFiles([
      {
        path: "quality/checks.ts",
        content: [
          'import { describe as group, it as spec } from "vitest";',
          'group("aliases", () => {',
          '  spec("are followed", () => verify());',
          "});",
        ].join("\n"),
      },
    ]);

    expect(result.units.find(({ kind }) => kind === "test")).toMatchObject({
      name: "aliases › are followed",
      startLine: 3,
      endLine: 3,
    });
  });

  it("supports modifiers, curried each calls, and test-only declarations", () => {
    const result = analyzeFiles([
      {
        path: "tests/runner.spec.ts",
        content: [
          'describe.each(cases)("case %s", (value) => {',
          '  test.concurrent.each(inputs)("input %s", async (input) => run(input));',
          '  it.skip("temporarily unavailable", () => retry(value));',
          "});",
        ].join("\n"),
      },
    ]);

    expect(
      result.units
        .filter(({ kind }) => kind === "test")
        .map(({ name }) => name),
    ).toEqual(["case %s › input %s", "case %s › temporarily unavailable"]);
  });

  it("distinguishes Playwright suites and hooks from configuration and steps", () => {
    const result = analyzeFiles([
      {
        path: "e2e/account.ts",
        content: [
          'import { test } from "@playwright/test";',
          'test.use({ locale: "en" });',
          'test.describe("account", () => {',
          "  test.beforeEach(async ({ page }) => page.goto('/'));",
          '  test("signs in", async ({ page }) => {',
          '    await test.step("submit form", async () => page.click("button"));',
          "  });",
          "});",
        ].join("\n"),
      },
    ]);

    expect(
      result.units
        .filter(({ kind }) => kind === "test")
        .map(({ name }) => name),
    ).toEqual(["account › signs in"]);
    expect(result.units.find(({ kind }) => kind === "test_hook")).toMatchObject(
      { name: "account › before each" },
    );
    expect(result.units.some(({ kind }) => kind === "test_suite")).toBe(false);
    expect(result.units.some(({ name }) => name.includes("submit form"))).toBe(
      false,
    );
    expect(
      result.units
        .find(({ name }) => name === "Test setup")
        ?.source.includes("test.use"),
    ).toBe(true);
  });

  it("supports default-export test APIs and their lifecycle methods", () => {
    const result = analyzeFiles([
      {
        path: "checks/availability.ts",
        content: [
          'import check from "ava";',
          "check.before(() => boot());",
          'check.serial("stays available", (context) => context.pass());',
        ].join("\n"),
      },
    ]);

    expect(result.units.find(({ kind }) => kind === "test_hook")).toMatchObject(
      { name: "before" },
    );
    expect(result.units.find(({ kind }) => kind === "test")).toMatchObject({
      name: "stays available",
    });
  });

  it("supports explicit Deno and Bun test APIs without filename heuristics", () => {
    const result = analyzeFiles([
      {
        path: "runtime/health.ts",
        content: [
          'Deno.test("deno health", async () => checkDeno());',
          'Bun.test("bun health", () => checkBun());',
        ].join("\n"),
      },
    ]);

    expect(
      result.units
        .filter(({ kind }) => kind === "test")
        .map(({ name }) => name),
    ).toEqual(["deno health", "bun health"]);
  });

  it("does not treat an unrelated business call as a test", () => {
    const result = analyzeFiles([
      {
        path: "src/experiment.ts",
        content: 'test("connection", () => connect());',
      },
    ]);

    expect(result.units.some(({ kind }) => kind === "test")).toBe(false);
    expect(
      result.units
        .filter(({ kind }) => kind !== "file")
        .map(({ kind }) => kind),
    ).toEqual(["module"]);
  });

  it("keeps separated test imports in context around logical setup", () => {
    const result = analyzeFiles([
      {
        path: "src/order.test.ts",
        content: [
          'import { it } from "vitest";',
          "const fixture = createFixture();",
          'import { order } from "./order";',
          'it("orders", () => expect(order(fixture)).toBeDefined());',
        ].join("\n"),
      },
    ]);

    expect(
      result.units.filter(({ name }) => name === "Test setup"),
    ).toHaveLength(0);
    expect(result.units.find(({ name }) => name === "fixture")).toMatchObject({
      kind: "constant",
      startLine: 2,
      endLine: 2,
    });
    expect(result.units.find(({ kind }) => kind === "file")?.source).toContain(
      'import { order } from "./order";',
    );
  });

  it("extracts pytest fixtures, functions, and unittest-style methods", () => {
    const result = analyzeFiles([
      {
        path: "tests/test_service.py",
        content: [
          "import pytest",
          "",
          "@pytest.fixture",
          "def client():",
          "    return Client()",
          "",
          "def test_health(client):",
          "    assert client.health()",
          "",
          "class TestService:",
          "    def setup_method(self):",
          "        self.service = Service()",
          "",
          "    def test_save(self):",
          "        assert self.service.save()",
        ].join("\n"),
      },
    ]);

    expect(
      result.units
        .filter(({ kind }) => kind === "test")
        .map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining(["test_health", "TestService › test_save"]),
    );
    expect(
      result.units
        .filter(({ kind }) => kind === "test_hook")
        .map(({ name }) => name),
    ).toEqual(expect.arrayContaining(["client", "TestService › setup_method"]));
    expect(
      result.units.some(
        ({ kind, name }) => kind === "class" && name === "TestService",
      ),
    ).toBe(false);
    expect(result.units.some(({ kind }) => kind === "test_suite")).toBe(false);
    expect(
      result.units.find(({ name }) => name.endsWith("test_save")),
    ).toMatchObject({ name: "TestService › test_save" });
    expect(result.units.some(({ kind }) => kind === "file")).toBe(true);
  });

  it("extracts context-manager BDD tests in Python", () => {
    const result = analyzeFiles([
      {
        path: "specs/calculator_spec.py",
        content: [
          'with description("calculator"):',
          '    with context("addition"):',
          '        with it("adds values"):',
          "            assert add(1, 2) == 3",
        ].join("\n"),
      },
    ]);

    expect(result.units.find(({ kind }) => kind === "test")).toMatchObject({
      name: "calculator › addition › adds values",
      startLine: 3,
      endLine: 4,
    });
    expect(result.units.some(({ kind }) => kind === "test_suite")).toBe(false);
    expect(result.units.some(({ kind }) => kind === "module")).toBe(false);
  });

  it("does not mistake production Python classes for test suites", () => {
    const result = analyzeFiles([
      {
        path: "src/domain.py",
        content: [
          "class TestDomain:",
          "    def execute(self):",
          "        return True",
        ].join("\n"),
      },
    ]);

    expect(
      result.units.find(({ name }) => name === "TestDomain"),
    ).toMatchObject({ kind: "class" });
    expect(result.units.some(({ kind }) => kind === "file")).toBe(true);
  });

  it("keeps module-level work in a test file reviewable", () => {
    const result = analyzeFiles([
      {
        path: "src/orders.test.ts",
        content: [
          'import { describe, expect, it } from "vitest";',
          'import { total } from "./orders";',
          "",
          "const FIXTURE = buildFixture({ currency: 'EUR' });",
          "",
          "process.env.TZ = 'UTC';",
          "",
          'describe("orders", () => {',
          '  it("totals", () => expect(total(FIXTURE)).toBe(3));',
          "});",
        ].join("\n"),
      },
    ]);

    // A process-wide side effect changes how every test in the file behaves, so
    // a reviewer has to see it even though the file is mostly scaffolding.
    expect(result.units.find(({ kind }) => kind === "module")).toMatchObject({
      name: "Module statements",
      startLine: 6,
      endLine: 6,
      source: "process.env.TZ = 'UTC';",
    });
    expect(result.units.find(({ name }) => name === "FIXTURE")).toMatchObject({
      kind: "constant",
    });
  });

  it("keeps a suite-level fixture reviewable without its suite chrome", () => {
    const result = analyzeFiles([
      {
        path: "src/pricing.test.ts",
        content: [
          'import { describe, expect, it } from "vitest";',
          "",
          'describe("discounts", () => {',
          '  it("applies", () => expect(price()).toBe(1));',
          "});",
          "",
          'describe("totals", () => {',
          "  const CART = [{ price: 2 }];",
          "",
          '  it("sums", () => expect(total(CART)).toBe(2));',
          "});",
        ].join("\n"),
      },
    ]);
    const modules = result.units.filter(({ kind }) => kind === "module");

    // The shared cart decides what every test in its suite asserts, so it earns
    // a card; the surrounding suite boundary lines are chrome and must not add
    // cards of their own, which would leave a reviewer with untitled noise.
    expect(modules.map(({ name }) => name)).toEqual([
      "Test setup",
      "Module statements",
    ]);
    expect(modules.at(-1)).toMatchObject({
      startLine: 7,
      endLine: 8,
      source: 'describe("totals", () => {\n  const CART = [{ price: 2 }];',
    });
  });

  it("adds no review units for a test file that is only scaffolding", () => {
    const result = analyzeFiles([
      {
        path: "src/scaffold.test.ts",
        content: [
          'import { describe, expect, it } from "vitest";',
          'import { total } from "./orders";',
          "",
          'describe("orders", () => {',
          '  it("totals", () => expect(total()).toBe(3));',
          '  it("empties", () => expect(total()).toBe(0));',
          "});",
          "",
        ].join("\n"),
      },
    ]);

    // Imports, the suite header, and the closing `});` are already represented
    // by the setup card and the test cards, so nothing else may reach review.
    expect(
      result.units
        .filter(({ kind }) => kind !== "file")
        .map(({ kind, name }) => `${kind}:${name}`),
    ).toEqual([
      "module:Test setup",
      "test:orders › totals",
      "test:orders › empties",
    ]);
  });

  it("surfaces module-level work left beside a language's inline test module", () => {
    const result = analyzeFiles([
      {
        path: "src/lib.rs",
        content: [
          "pub fn add(left: u8, right: u8) -> u8 {",
          "    left + right",
          "}",
          "",
          "pub static LIMIT: u8 = 10;",
          "",
          "#[cfg(test)]",
          "mod tests {",
          "    use super::*;",
          "",
          "    #[test]",
          "    fn adds() {",
          "        assert_eq!(add(1, 2), 3);",
          "    }",
          "}",
        ].join("\n"),
      },
    ]);

    // Rust keeps tests inside the file they cover, so production declarations
    // must stay reviewable there; only the module's imports and its closing
    // brace are context a reviewer never has to sign off separately.
    expect(result.units.find(({ name }) => name === "LIMIT")).toMatchObject({
      kind: "variable",
      startLine: 5,
    });
    expect(
      result.units
        .filter(({ kind }) => kind !== "file")
        .some(({ source }) => source.includes("use super::*;")),
    ).toBe(false);
    expect(
      result.units.filter(({ name }) => name === "Module statements"),
    ).toHaveLength(0);
  });

  it("invalidates only the changed test and its aggregate file context", () => {
    const before = analyzeFiles([
      {
        path: "math.test.ts",
        content: [
          'import { it } from "vitest";',
          'it("one", () => expect(total()).toBe(1));',
          'it("two", () => expect(total()).toBe(2));',
        ].join("\n"),
      },
    ]).units;
    const after = analyzeFiles([
      {
        path: "math.test.ts",
        content: [
          'import { it } from "vitest";',
          'it("one", () => expect(total()).toBe(10));',
          'it("two", () => expect(total()).toBe(2));',
        ].join("\n"),
      },
    ]).units;

    const impact = reconcileSignOffs(before, after);
    expect(impact.find(({ unit }) => unit.name === "one")?.requiresReview).toBe(
      true,
    );
    expect(impact.find(({ unit }) => unit.name === "two")?.requiresReview).toBe(
      false,
    );
    expect(
      impact.find(({ unit }) => unit.kind === "file")?.requiresReview,
    ).toBe(true);
  });
});

describe("GoogleTest case names", () => {
  it.each([
    ["TEST", "TEST(PondSuite, HoldsWater)", "PondSuite › HoldsWater"],
    ["TEST_F", "TEST_F(PondFixture, Refills)", "PondFixture › Refills"],
    ["TEST_P", "TEST_P(PondParams, Drains)", "PondParams › Drains"],
    ["TYPED_TEST", "TYPED_TEST(PondTyped, Floats)", "PondTyped › Floats"],
  ])("names a %s case after its suite and case", (_macro, header, name) => {
    // Every one of these spells the suite and the case the same way. Matching
    // only the fixture form left the rest named after the macro, so a file of
    // them held several cards all called "TEST".
    const units = analyzeFiles([
      {
        path: "pond_test.cc",
        content: `#include <gtest/gtest.h>\n\n${header} {\n  EXPECT_TRUE(true);\n}\n`,
        changeType: "added",
      },
    ]).units.filter(({ kind }) => kind !== "file");

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: "test", name });
  });

  it("still reads a Catch2 case from its description", () => {
    const units = analyzeFiles([
      {
        path: "pond_test.cc",
        content:
          '#include <catch2/catch.hpp>\n\nTEST_CASE("the pond holds water") {\n  REQUIRE(true);\n}\n',
        changeType: "added",
      },
    ]).units.filter(({ kind }) => kind !== "file");

    expect(units[0]?.name).toBe("the pond holds water");
  });
});
