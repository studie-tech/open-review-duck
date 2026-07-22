import { describe, expect, it } from "vitest";
import type { SourceFile } from "../../types";
import { cppAdapter, cppParserInternals } from ".";

/** Analyzes an in-memory C++ fixture with the production adapter. */
function analyze(content: string, path = "src/example.cpp") {
  return cppAdapter.analyze({ path, content, changeType: "added" });
}

/** Returns a named unit while producing useful fixture diagnostics. */
function named(units: ReturnType<typeof analyze>, name: string) {
  const unit = units.find((candidate) => candidate.name === name);
  expect(
    unit,
    `Expected unit ${name}; received ${units.map((candidate) => candidate.name).join(", ")}`,
  ).toBeDefined();
  if (!unit) throw new Error(`Missing unit ${name}`);
  return unit;
}

describe("C++ review analysis", () => {
  it("extracts documented, qualified language concepts without duplicating class bodies", () => {
    const units = analyze(`#pragma once
#include <memory>

namespace review::core {
/** Restricts a value to a compile-time range. */
template <class T>
[[nodiscard]] constexpr T clamp(T value, T low, T high) {
  return value < low ? low : value > high ? high : value;
}

/// Owns one review item.
template <typename Storage>
class Widget final : public BaseWidget {
 public:
  using Id = unsigned long;
  static constexpr int max_items = 24;
  int count;

  explicit Widget(int value) : count{value} {}
  ~Widget() = default;
  int current() const { return clamp(count, 0, max_items); }

  struct State {
    int revision;
  };
};

enum class Mode { fast, careful };
template <typename T>
concept Persistable = requires(T value) { value.save(); };
using Handler = void (*)(Mode);
constinit Widget<int>* active_widget = nullptr;
}
`);

    const clamp = named(units, "clamp");
    expect(clamp.kind).toBe("function");
    expect(clamp.source).toContain("/** Restricts a value");
    expect(clamp.source).toContain("template <class T>");
    expect(clamp.stableKey).toContain("review::core::clamp");

    const widget = named(units, "Widget");
    expect(widget.kind).toBe("class");
    expect(widget.source).toContain("/// Owns one review item.");
    expect(widget.source).toContain("class Widget final");
    expect(widget.source).not.toContain("max_items = 24");

    expect(named(units, "Widget::max_items").kind).toBe("constant");
    expect(named(units, "Widget::count").kind).toBe("variable");
    expect(named(units, "Widget::Widget").kind).toBe("method");
    expect(named(units, "Widget::~Widget").kind).toBe("method");
    const current = named(units, "Widget::current");
    expect(current.dependencies).toContain(clamp.stableKey);
    expect(widget.dependencies).toEqual(
      expect.arrayContaining([
        current.stableKey,
        named(units, "Widget::max_items").stableKey,
        named(units, "State").stableKey,
      ]),
    );
    expect(named(units, "State").stableKey).toContain(
      "review::core::Widget::State",
    );
    expect(named(units, "Mode").source).toContain("careful");
    expect(named(units, "Persistable").kind).toBe("variable");
    expect(named(units, "Handler").kind).toBe("variable");
    expect(named(units, "active_widget").kind).toBe("constant");
  });

  it("handles special members, operators, prototypes, and same-file dependencies", () => {
    const units = analyze(`namespace math {
int leaf(int value) { return value + 1; }
int branch(int value) { return leaf(value) * 2; }

class Number {
 public:
  Number();
  Number(const Number&) = default;
  Number& operator=(const Number&) = default;
  explicit operator bool() const { return value_ != 0; }
  int operator()(int offset) const { return branch(value_ + offset); }
 private:
  int value_ = 0;
};
}
`);
    const leaf = named(units, "leaf");
    expect(named(units, "branch").dependencies).toContain(leaf.stableKey);
    expect(named(units, "Number::Number").kind).toBe("method");
    expect(named(units, "Number::operator=").kind).toBe("method");
    expect(named(units, "Number::operatorbool").kind).toBe("method");
    expect(named(units, "Number::operator()").kind).toBe("method");
    expect(named(units, "Number::value_").kind).toBe("variable");
  });

  it("keeps custom-type globals and namespace registration statements reviewable", () => {
    const units = analyze(`namespace plugins {
Widget primary;
std::vector<Widget> queue;
Widget aggregate{1, 2};
REGISTER_WIDGET(primary);
}
`);
    expect(named(units, "primary").kind).toBe("variable");
    expect(named(units, "queue").kind).toBe("variable");
    expect(named(units, "aggregate").kind).toBe("variable");
    const setup = named(units, "plugins namespace statements");
    expect(setup.kind).toBe("module");
    expect(setup.source).toContain("REGISTER_WIDGET(primary)");
  });

  it("splits GoogleTest, Catch2, fixtures, and lifecycle hooks into focused units", () => {
    const units = analyze(
      `#include <gtest/gtest.h>
#include <catch2/catch_test_macros.hpp>

class CacheTest : public testing::Test {
 protected:
  void SetUp() override { cache.seed(); }
  void TearDown() override { cache.clear(); }
  Cache cache;
};

TEST_F(CacheTest, EvictsOldest) {
  EXPECT_TRUE(cache.evict());
}

TEST_CASE("reads a raw value", "[cache]") {
  REQUIRE(read() == 1);
}

class ProductionService {
 public:
  void SetUp() { start(); }
};
`,
      "tests/cache_test.cpp",
    );

    expect(named(units, "CacheTest::SetUp").kind).toBe("test_hook");
    expect(named(units, "CacheTest::TearDown").kind).toBe("test_hook");
    expect(named(units, "CacheTest › EvictsOldest").kind).toBe("test");
    expect(named(units, "reads a raw value").kind).toBe("test");
    expect(named(units, "ProductionService::SetUp").kind).toBe("method");
  });

  it("extracts material macros but omits include guards and literal decoys", () => {
    const units = analyze(
      `#ifndef UNUSUAL_HEADER_SENTINEL
#define UNUSUAL_HEADER_SENTINEL
#include "widget.hpp"

/** Squares without evaluating its argument twice. */
#define PROJECT_SQUARE(value) \\
  ([&] { const auto copy = (value); return copy * copy; }())
#define DEFAULT_CAPACITY 64

const char* sample = R"cpp(
class Fake { void nope() {} };
#define ALSO_FAKE(x) x
)cpp";

#endif
`,
      "include/widget.hpp",
    );

    expect(units.some(({ name }) => name === "UNUSUAL_HEADER_SENTINEL")).toBe(
      false,
    );
    expect(named(units, "PROJECT_SQUARE").kind).toBe("function");
    expect(named(units, "PROJECT_SQUARE").source).toContain("Squares without");
    expect(named(units, "DEFAULT_CAPACITY").kind).toBe("constant");
    expect(named(units, "sample").kind).toBe("variable");
    expect(units.some(({ name }) => name === "Fake")).toBe(false);
    expect(units.some(({ name }) => name === "ALSO_FAKE")).toBe(false);
  });

  it("keeps imports, module declarations, pragmas, and guards as file context", () => {
    const context = `#ifndef LIB_HPP
#define LIB_HPP
#pragma once
#include <vector>
#include "local.hpp"
#endif
`;
    expect(
      cppAdapter.analyze({
        path: "include/lib.hpp",
        content: context,
      } satisfies SourceFile),
    ).toEqual([]);
    expect(cppAdapter.isContextOnly?.(context)).toBe(true);
    expect(
      cppAdapter.isContextOnly?.("export module review.core;\nimport std;"),
    ).toBe(true);
    expect(cppAdapter.isContextOnly?.("#include <x>\nint value = 1;")).toBe(
      false,
    );
  });

  it("masks comments, escaped literals, raw strings, and preprocessor continuations", () => {
    const source = `const char quote = '\\'';
const char* text = "void fake() { }";
auto raw = u8R<tag>(namespace fake { class Nope {}; })tag>;
// int comment_only() {}
/* struct Hidden {}; */
#define MULTI(x) \\
  ((x) + 1)
int real() { return MULTI(1); }
`;
    const units = analyze(source);
    expect(units.some(({ name }) => name === "fake")).toBe(false);
    expect(units.some(({ name }) => name === "Nope")).toBe(false);
    expect(units.some(({ name }) => name === "comment_only")).toBe(false);
    expect(units.some(({ name }) => name === "Hidden")).toBe(false);
    expect(named(units, "MULTI").kind).toBe("function");
    expect(named(units, "real").kind).toBe("function");
    expect(cppParserInternals.maskCppSource(source)).toHaveLength(
      source.length,
    );
  });
});
