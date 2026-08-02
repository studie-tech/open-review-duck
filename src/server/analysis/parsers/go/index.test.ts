import { describe, expect, it } from "vitest";
import type { SourceFile } from "../../types";
import { goAdapter } from ".";

/** Analyzes an in-memory Go fixture with the production adapter. */
function analyze(content: string, path = "queue/queue.go") {
  return goAdapter.analyze({ path, content, changeType: "added" });
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

describe("Go review analysis", () => {
  it("extracts documented generic types, fields, interfaces, aliases, and defined types", () => {
    const units = analyze(`package queue

// Queue stores values in insertion order.
type Queue[T comparable] struct {
    // items owns the queued values.
    items []T
    index map[T]int
    embeddedState
}

type Store[T any] interface {
    Load(key string) (T, error)
    Save(key string, value T) error
    ~string | ~[]byte
}

type Identifier = string
type State uint8
type Predicate[T any] func(T) bool

type (
    Grouped struct { Value int }
    GroupedStore interface { Get() Grouped }
)
`);
    const queue = named(units, "Queue");
    expect(queue.source).toContain("Queue stores values");
    expect(queue.source).not.toContain("items []T");
    expect(named(units, "Queue.items").source).toContain("items owns");
    expect(named(units, "Queue.index").kind).toBe("variable");
    expect(named(units, "Queue.embeddedState").kind).toBe("variable");
    expect(queue.dependencies).toEqual(
      expect.arrayContaining([
        named(units, "Queue.items").stableKey,
        named(units, "Queue.index").stableKey,
      ]),
    );
    const store = named(units, "Store");
    expect(named(units, "Store.Load").kind).toBe("method");
    expect(named(units, "Store.Save").kind).toBe("method");
    expect(store.dependencies).toContain(named(units, "Store.Load").stableKey);
    expect(named(units, "Identifier").kind).toBe("class");
    expect(named(units, "State").kind).toBe("class");
    expect(named(units, "Predicate").kind).toBe("class");
    expect(named(units, "Grouped.Value").kind).toBe("variable");
    expect(named(units, "GroupedStore.Get").kind).toBe("method");
  });

  it("qualifies pointer and generic receiver methods and links them to type shells", () => {
    const units = analyze(`package queue

type Queue[T any] struct { items []T }

// Push appends a value.
func (q *Queue[T]) Push(value T) {
    q.items = append(q.items, value)
}

func (q Queue[T]) Len() int { return len(q.items) }

func Build[T any](values ...T) *Queue[T] {
    queue := &Queue[T]{}
    for _, value := range values { queue.Push(value) }
    return queue
}
`);
    const push = named(units, "Queue.Push");
    expect(push.kind).toBe("method");
    expect(push.source).toContain("Push appends a value");
    expect(named(units, "Queue.Len").kind).toBe("method");
    expect(named(units, "Queue").dependencies).toEqual(
      expect.arrayContaining([
        push.stableKey,
        named(units, "Queue.Len").stableKey,
      ]),
    );
    const build = named(units, "Build");
    expect(build.kind).toBe("function");
    expect(build.dependencies).toEqual(
      expect.arrayContaining([named(units, "Queue").stableKey, push.stableKey]),
    );
  });

  it("handles grouped constants with iota semantics and independent declarations", () => {
    const units = analyze(`package queue

type State uint8
type Queue[T any] struct { values []T }
const (
    StateUnknown State = iota
    StateQueued
    StateRunning
)

const (
    DefaultCapacity = 32
    MaximumCapacity = 1024
)

var (
    activeQueue *Queue[int]
    attempts, failures uint64
)
`);
    const states = named(units, "StateUnknown constants");
    expect(states.kind).toBe("constant");
    expect(states.source).toContain("StateRunning");
    expect(named(units, "DefaultCapacity").kind).toBe("constant");
    expect(named(units, "MaximumCapacity").kind).toBe("constant");
    expect(named(units, "activeQueue").dependencies).toContain(
      named(units, "Queue").stableKey,
    );
    expect(named(units, "attempts, failures").kind).toBe("variable");
  });

  it("keeps package-level data, setup, init functions, and named function literals reviewable", () => {
    const units = analyze(`package queue

type command struct { name string; run func() error }
func start() error { return nil }

var commands = map[string]command{
    "start": {name: "start", run: start},
}

var fallback = func(value int) int { return value + 1 }

func init() { register(commands) }
func init() { registerFallback(fallback) }

func transform(values []int) []int {
    keep := func(value int) bool { return value > 0 }
    return filter(values, keep)
}
`);
    const commands = named(units, "commands");
    expect(commands.source).toContain('"start"');
    expect(commands.dependencies).toContain(named(units, "start").stableKey);
    expect(named(units, "fallback").kind).toBe("function");
    expect(units.filter(({ name }) => name === "init")).toHaveLength(2);
    const closure = named(units, "transform.keep");
    expect(closure.kind).toBe("function");
    expect(named(units, "transform").dependencies).toContain(closure.stableKey);
  });

  it("classifies standard Go tests, examples, benchmarks, fuzzers, and TestMain", () => {
    const units = analyze(
      `package queue_test
import "testing"

func TestQueue(t *testing.T) {
    t.Run("empty", func(t *testing.T) { t.Fatal("expected") })
}
func BenchmarkQueue(b *testing.B) { for i := 0; i < b.N; i++ { build() } }
func FuzzQueue(f *testing.F) { f.Fuzz(func(t *testing.T, value []byte) { parse(value) }) }
func ExampleQueue() { fmt.Println("queue") }
func Example() { fmt.Println("package") }
func TestMain(m *testing.M) { os.Exit(m.Run()) }
func helper(t *testing.T) { t.Helper() }
`,
      "queue/queue_test.go",
    );
    expect(named(units, "TestQueue").kind).toBe("test");
    expect(named(units, "BenchmarkQueue").kind).toBe("test");
    expect(named(units, "FuzzQueue").kind).toBe("test");
    expect(named(units, "ExampleQueue").kind).toBe("test");
    expect(named(units, "Example").kind).toBe("test");
    expect(named(units, "TestMain").kind).toBe("test");
    expect(named(units, "helper").kind).toBe("function");
    expect(units.some(({ name }) => name.includes("empty"))).toBe(false);
  });

  it("recognizes testify suite methods and setup helpers", () => {
    const units = analyze(
      `package queue
type QueueSuite struct { suite.Suite }
func (suite *QueueSuite) SetupSuite() { connect() }
func (suite *QueueSuite) SetupTest() { reset() }
func (suite *QueueSuite) TearDownTest() { cleanup() }
func (suite *QueueSuite) TestPush() { suite.True(push()) }
func setupDatabase(t *testing.T) *DB { return openDB() }
`,
      "queue/suite_test.go",
    );
    expect(named(units, "QueueSuite.SetupSuite").kind).toBe("test_hook");
    expect(named(units, "QueueSuite.SetupTest").kind).toBe("test_hook");
    expect(named(units, "QueueSuite.TearDownTest").kind).toBe("test_hook");
    expect(named(units, "QueueSuite.TestPush").kind).toBe("test");
    expect(named(units, "setupDatabase").kind).toBe("test_hook");
  });

  it("preserves multiline signatures, generic type sets, and semicolon insertion", () => {
    const units = analyze(`package numeric

type Number interface {
    ~int | ~int64 |
        ~float64
}

func Sum[
    T Number,
](
    values []T,
) T {
    var total T
    for _, value := range values {
        total += value
    }
    return total
}

const Label = "sum"
var Enabled = true
`);
    expect(named(units, "Sum").kind).toBe("function");
    expect(named(units, "Sum").dependencies).toContain(
      named(units, "Number").stableKey,
    );
    expect(named(units, "Label").kind).toBe("constant");
    expect(named(units, "Enabled").kind).toBe("variable");
  });

  it("masks interpreted/raw strings, rune literals, comments, and composite braces", () => {
    const source = `package masks
// func commented() { panic("no") }
/* type Hidden struct { value int } */
const Raw = \`func fake() { return }\`
const Interpreted = "type Nope struct { X int }"
const Closing = '}'
var Table = []struct{ Name string }{
    {Name: "{"},
}
func Real() rune { return Closing }
`;
    const units = analyze(source);
    expect(units.some(({ name }) => name === "commented")).toBe(false);
    expect(units.some(({ name }) => name === "Hidden")).toBe(false);
    expect(units.some(({ name }) => name === "fake")).toBe(false);
    expect(units.some(({ name }) => name === "Nope")).toBe(false);
    expect(named(units, "Raw").kind).toBe("constant");
    expect(named(units, "Interpreted").kind).toBe("constant");
    expect(named(units, "Closing").kind).toBe("constant");
    expect(named(units, "Table").kind).toBe("variable");
    expect(named(units, "Table").source).toContain('{Name: "{"}');
    expect(named(units, "Real").kind).toBe("function");
  });

  it("recognizes package and import-only files as context", () => {
    const context = `//go:build linux

// Package platform provides OS-specific helpers.
package platform

import (
    "context"
    alias "example.com/project/model"
    _ "example.com/project/register"
)
`;
    expect(
      goAdapter.analyze({
        path: "platform/imports.go",
        content: context,
      } satisfies SourceFile),
    ).toEqual([]);
    expect(goAdapter.isContextOnly?.(context)).toBe(true);
    expect(
      goAdapter.isContextOnly?.('package x\nimport "fmt"\nconst X = 1\n'),
    ).toBe(false);
    expect(goAdapter.extensions).toEqual([".go"]);
  });
});
