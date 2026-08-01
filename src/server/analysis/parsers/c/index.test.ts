import { describe, expect, it } from "vitest";
import type { SourceFile } from "../../types";
import { cAdapter } from ".";

/** Analyzes an in-memory C fixture with the production adapter. */
function analyze(content: string, path = "src/example.c") {
  return cAdapter.analyze({ path, content, changeType: "added" });
}

/** Returns a named unit while producing useful fixture diagnostics. */
function named(units: ReturnType<typeof analyze>, name: string) {
  const unit = units.find((candidate) => candidate.name === name);
  expect(
    unit,
    `Expected ${name}; received ${units.map((candidate) => candidate.name).join(", ")}`,
  ).toBeDefined();
  if (!unit) throw new Error(`Missing unit ${name}`);
  return unit;
}

describe("C review analysis", () => {
  it("extracts documented functions, constants, globals, and same-file dependencies", () => {
    const units = analyze(`#include "counter.h"

/** Maximum accepted counter value. */
static const unsigned MAX_COUNT = 64U;

static unsigned normalize(unsigned value)
{
    return value > MAX_COUNT ? MAX_COUNT : value;
}

/** Updates a counter without exceeding the configured maximum. */
int counter_update(struct counter *counter, unsigned requested)
{
    counter->value = normalize(requested);
    return (int)counter->value;
}
`);

    const maximum = named(units, "MAX_COUNT");
    expect(maximum.kind).toBe("constant");
    expect(maximum.source).toContain("Maximum accepted counter value");
    const normalize = named(units, "normalize");
    expect(normalize.kind).toBe("function");
    expect(normalize.dependencies).toContain(maximum.stableKey);
    const update = named(units, "counter_update");
    expect(update.source).toContain("Updates a counter");
    expect(update.dependencies).toContain(normalize.stableKey);
  });

  it("splits aggregate shells, members, enum values, aliases, and function pointers", () => {
    const units = analyze(`/** One queued operation. */
typedef struct operation {
    const char *name;
    int priority;
    unsigned enabled : 1;
    void (*execute)(void *context);
} operation_t;

typedef union payload {
    long integer;
    void *pointer;
} payload_t;

typedef enum result_code {
    RESULT_OK = 0,
    RESULT_RETRY,
    RESULT_FATAL = -1
} result_code_t;

typedef void (*completion_fn)(result_code_t result, void *context);
`);

    const operation = named(units, "operation_t");
    expect(operation.kind).toBe("class");
    expect(operation.source).toContain("One queued operation");
    expect(operation.source).not.toContain("const char *name");
    expect(named(units, "operation_t.name").kind).toBe("variable");
    expect(named(units, "operation_t.priority").kind).toBe("variable");
    expect(named(units, "operation_t.enabled").kind).toBe("variable");
    expect(named(units, "operation_t.execute").kind).toBe("variable");
    expect(operation.dependencies).toEqual(
      expect.arrayContaining([
        named(units, "operation_t.name").stableKey,
        named(units, "operation_t.execute").stableKey,
      ]),
    );
    expect(named(units, "payload_t.pointer").kind).toBe("variable");
    expect(named(units, "result_code_t.RESULT_OK").kind).toBe("constant");
    expect(named(units, "result_code_t.RESULT_FATAL").source).toContain("-1");
    expect(named(units, "completion_fn").kind).toBe("variable");
  });

  it("reviews public or documented prototypes but leaves private forward declarations as context", () => {
    const publicUnits = analyze(
      `#pragma once
struct item;
/** Releases ownership of an item. */
void item_release(struct item *item);
int item_count(const struct item *item);
typedef int (*item_compare_fn)(const struct item *, const struct item *);
`,
      "include/item.h",
    );
    expect(named(publicUnits, "item_release").kind).toBe("function");
    expect(named(publicUnits, "item_count").stableKey).toContain(
      "prototype:item_count",
    );
    expect(named(publicUnits, "item_compare_fn").kind).toBe("variable");

    const implementation = analyze(`static int helper(int value);
static int helper(int value) { return value + 1; }
`);
    expect(implementation.filter(({ name }) => name === "helper")).toHaveLength(
      1,
    );
    expect(named(implementation, "helper").source).toContain(
      "return value + 1",
    );
  });

  it("keeps initialization tables and designated data as focused review units", () => {
    const units = analyze(`struct command {
    const char *name;
    int (*run)(void);
};

static int start(void) { return 1; }
static int stop(void) { return 0; }

static const struct command COMMANDS[] = {
    [0] = { .name = "start", .run = start },
    [3] = { .name = "stop", .run = stop },
};

struct command *active_command = 0;
`);
    const table = named(units, "COMMANDS");
    expect(table.kind).toBe("constant");
    expect(table.source).toContain("[3] =");
    expect(table.dependencies).toEqual(
      expect.arrayContaining([
        named(units, "start").stableKey,
        named(units, "stop").stableKey,
      ]),
    );
    expect(named(units, "active_command").dependencies).toContain(
      named(units, "command").stableKey,
    );
  });

  it("extracts Unity, CMocka, Check, and Criterion tests plus lifecycle hooks", () => {
    const units = analyze(
      `#include <criterion/criterion.h>
void setUp(void) { reset_fixture(); }
void tearDown(void) { release_fixture(); }
void test_unity_adds_values(void) { TEST_ASSERT_EQUAL(2, add(1, 1)); }
static void test_cmocka_rejects_null(void **state) { assert_null(parse(0)); }

START_TEST(check_accepts_input)
{
    ck_assert_int_eq(parse("ok"), 1);
}
END_TEST

Test(parser, accepts_spaces) {
    cr_assert_eq(parse(" "), 1);
}
`,
      "tests/parser_test.c",
    );
    expect(named(units, "setUp").kind).toBe("test_hook");
    expect(named(units, "tearDown").kind).toBe("test_hook");
    expect(named(units, "test_unity_adds_values").kind).toBe("test");
    expect(named(units, "test_cmocka_rejects_null").kind).toBe("test");
    expect(named(units, "check_accepts_input").kind).toBe("test");
    expect(named(units, "parser › accepts_spaces").kind).toBe("test");
  });

  it("handles multiline macros, excludes header guards, and attaches macro docs", () => {
    const units = analyze(
      `#ifndef PROJECT_QUEUE_H
#define PROJECT_QUEUE_H
#include <stddef.h>

/** Executes an operation once when it is non-null. */
#define RUN_IF_PRESENT(operation, context) \\
    do { \\
        if ((operation) != NULL) { \\
            (operation)(context); \\
        } \\
    } while (0)

#define DEFAULT_QUEUE_SIZE 32U
#define QUEUE_FEATURE_ENABLED
#endif
`,
      "include/queue.h",
    );
    expect(units.some(({ name }) => name === "PROJECT_QUEUE_H")).toBe(false);
    const run = named(units, "RUN_IF_PRESENT");
    expect(run.kind).toBe("function");
    expect(run.source).toContain("Executes an operation once");
    expect(run.source).toContain("while (0)");
    expect(named(units, "DEFAULT_QUEUE_SIZE").kind).toBe("constant");
    expect(named(units, "QUEUE_FEATURE_ENABLED").kind).toBe("constant");
  });

  it("supports old-style definitions and compiler attributes", () => {
    const units = analyze(`__attribute__((warn_unused_result))
static int modern(int value) { return value; }
int visit_items(int (*visitor)(const char *name, void *context), void *context)
{
    return visitor("item", context);
}

int legacy_sum(left, right)
int left;
int right;
{
    return left + right;
}
`);
    expect(named(units, "modern").kind).toBe("function");
    expect(named(units, "visit_items").kind).toBe("function");
    expect(units.some(({ name }) => name === "visitor")).toBe(false);
    const legacy = named(units, "legacy_sum");
    expect(legacy.source).toContain("int left;");
    expect(legacy.source).toContain("return left + right");
    expect(units.some(({ name }) => name === "left")).toBe(false);
  });

  it("masks misleading comments, strings, chars, and braces in initializers", () => {
    const source = `const char quote = '}';
const char *text = "int fake(void) { return 1; }";
/* struct hidden { int member; }; */
// void commented_out(void) {}
static const char ESCAPES[] = "\\"{/*";
int real(void) { return quote == '}'; }
`;
    const units = analyze(source);
    expect(units.some(({ name }) => name === "fake")).toBe(false);
    expect(units.some(({ name }) => name === "hidden")).toBe(false);
    expect(units.some(({ name }) => name === "commented_out")).toBe(false);
    expect(named(units, "ESCAPES").kind).toBe("constant");
    expect(named(units, "real").kind).toBe("function");
  });

  it("recognizes include, pragma, and header-guard-only files as context", () => {
    const context = `#ifndef ONLY_CONTEXT_H
#define ONLY_CONTEXT_H
#pragma once
#include <stddef.h>
#include "local.h"
#endif
`;
    expect(
      cAdapter.analyze({
        path: "include/only_context.h",
        content: context,
      } satisfies SourceFile),
    ).toEqual([]);
    expect(cAdapter.isContextOnly?.(context)).toBe(true);
    expect(cAdapter.isContextOnly?.("#include <x.h>\nint value = 1;")).toBe(
      false,
    );
    expect(cAdapter.extensions).toEqual([".c", ".h"]);
  });
});
