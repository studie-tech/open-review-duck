import { describe, expect, it } from "vitest";
import type { SourceFile } from "../../types";
import {
  isContextOnly,
  makefileAdapter,
  makefileExtensions,
  makefileFileNames,
} from ".";

/** Analyzes an in-memory Makefile fixture. */
function analyze(content: string, path = "Makefile") {
  return makefileAdapter.analyze({
    path,
    content,
    changeType: "added",
  } satisfies SourceFile);
}

/** Returns a fixture unit by name with a useful assertion failure. */
function named(units: ReturnType<typeof analyze>, name: string) {
  const unit = units.find((candidate) => candidate.name === name);
  expect(
    unit,
    `Expected ${name}; received ${units.map(({ kind, name: actual }) => `${kind}:${actual}`).join(", ")}`,
  ).toBeDefined();
  if (!unit) throw new Error(`Missing Make unit ${name}`);
  return unit;
}

describe("Makefile review parser", () => {
  it("extracts documented variable flavors and connects variable and target dependencies", () => {
    const units = analyze(`# C compiler selected by release builds.
override CC := clang
SOURCES := src/main.c src/review.c
OBJECTS := $(SOURCES:.c=.o)
CFLAGS ?= -O2
CFLAGS += -Wall
export BUILD_DIR = build

objects: CFLAGS += -fPIC

# Links the application.
app: $(OBJECTS) | $(BUILD_DIR)
	$(CC) $(CFLAGS) -o $@ $(OBJECTS)

all: app
`);

    const compiler = named(units, "CC · override simple");
    expect(compiler.kind).toBe("constant");
    expect(compiler.source).toContain("C compiler selected");
    const sources = named(units, "SOURCES · simple");
    expect(named(units, "OBJECTS · simple").dependencies).toContain(
      sources.stableKey,
    );
    expect(named(units, "CFLAGS · conditional").kind).toBe("constant");
    expect(named(units, "CFLAGS · append").kind).toBe("constant");
    expect(named(units, "BUILD_DIR · export recursive").kind).toBe("constant");
    const scoped = named(units, "objects: CFLAGS · append");
    expect(scoped.kind).toBe("constant");

    const app = named(units, "app");
    expect(app.kind).toBe("function");
    expect(app.source).toContain("\t$(CC)");
    expect(app.dependencies).toEqual(
      expect.arrayContaining([
        compiler.stableKey,
        named(units, "OBJECTS · simple").stableKey,
        named(units, "BUILD_DIR · export recursive").stableKey,
      ]),
    );
    expect(named(units, "all").dependencies).toContain(app.stableKey);
  });

  it("keeps define blocks intact and resolves call references", () => {
    const units = analyze(`# Runs a named project tool.
override define run-tool
	@echo "running $(1)"
	@$(1) $(2)
endef

define nested-template
define generated
value
endef
$(eval $(generated))
endef

lint:
	$(call run-tool,ruff,check .)
`);

    const canned = named(units, "run-tool (canned recipe)");
    expect(canned.kind).toBe("function");
    expect(canned.source).toContain("Runs a named project tool");
    expect(canned.source).toContain("endef");
    expect(named(units, "nested-template (canned recipe)").source).toContain(
      "define generated",
    );
    const lint = named(units, "lint");
    expect(lint.kind).toBe("test");
    expect(lint.dependencies).toContain(canned.stableKey);
  });

  it("supports pattern, suffix, static-pattern, grouped, double-colon, and inline rules", () => {
    const units = analyze(`%.o: %.c include/config.h
	$(CC) -c $< -o $@

.c.s:
	$(CC) -S $< -o $@

main.o util.o: %.o: %.c
	$(CC) -c $< -o $@

parser lexer &: grammar.y
	bison grammar.y

clean:: ; rm -rf build
clean:: ; rm -rf coverage
`);

    expect(named(units, "%.o").source).toContain("$(CC) -c");
    expect(named(units, ".c.s").kind).toBe("function");
    expect(named(units, "main.o + util.o").source).toContain("%.o: %.c");
    expect(named(units, "parser & lexer").source).toContain("grammar.y");
    expect(units.filter(({ name }) => name === "clean")).toHaveLength(2);
    expect(
      units
        .filter(({ name }) => name === "clean")
        .map(({ stableKey }) => stableKey),
    ).toHaveLength(2);
    expect(
      new Set(
        units
          .filter(({ name }) => name === "clean")
          .map(({ stableKey }) => stableKey),
      ).size,
    ).toBe(2);
  });

  it("models phony metadata, test targets, and setup helpers", () => {
    const units = analyze(`.PHONY: all test check setup clean

setup:
	@mkdir -p .cache

test: setup
	pytest -q

check: test lint

lint:
	ruff check .

all: check

.DELETE_ON_ERROR:
`);

    const setup = named(units, "setup");
    expect(setup.kind).toBe("test_hook");
    const test = named(units, "test");
    expect(test.kind).toBe("test");
    expect(test.dependencies).toContain(setup.stableKey);
    expect(named(units, "check").dependencies).toEqual(
      expect.arrayContaining([test.stableKey, named(units, "lint").stableKey]),
    );
    expect(named(units, "Phony targets").dependencies).toEqual(
      expect.arrayContaining([test.stableKey, named(units, "all").stableKey]),
    );
    expect(named(units, ".DELETE_ON_ERROR").kind).toBe("module");
  });

  it("keeps configuration branches and target metadata with their owning concepts", () => {
    const units = analyze(`SHELL := bash

.DEFAULT_GOAL := help
PORT ?= 3666

ifneq (,$(TERM))
COLOR := yes
else
COLOR :=
endif

---------------General------------------: # visual divider
.PHONY: help
help: # Print command reference
	@echo "$(COLOR)help"

-----------Local Development------------: # visual divider
.PHONY: start
start: # Start services
	@echo "port $(PORT)"
`);

    expect(units.map(({ name }) => name)).toEqual([
      "Build configuration",
      "help",
      "start",
    ]);
    const configuration = named(units, "Build configuration");
    expect(configuration.source).toContain("ifneq");
    expect(configuration.source).toContain("endif");
    expect(named(units, "help").source).toContain(".PHONY: help");
    expect(named(units, "help").source).toContain("General");
    expect(named(units, "start").source).toContain(".PHONY: start");
    expect(named(units, "help").dependencies).toContain(
      configuration.stableKey,
    );
    expect(named(units, "start").dependencies).toContain(
      configuration.stableKey,
    );
  });

  it("connects recursive Make calls without parsing arbitrary recipe shell", () => {
    const units = analyze(`frontend:
	@echo "frontend: is recipe text"

backend:
	@echo ready

release:
	$(MAKE) --no-print-directory frontend backend MODE=release
`);
    expect(named(units, "release").dependencies).toEqual(
      expect.arrayContaining([
        named(units, "frontend").stableKey,
        named(units, "backend").stableKey,
      ]),
    );
    expect(units.some(({ name }) => name === "is recipe text")).toBe(false);
  });

  it("keeps conditionals reviewable while splitting declarations and rules inside", () => {
    const units = analyze(`# Platform selection
ifeq ($(OS),Windows_NT)
EXE := .exe
run: app$(EXE)
	.\\app$(EXE)
else ifeq ($(shell uname),Darwin)
EXE :=
run: app
	./app
else
EXE :=
endif
`);

    const conditional = named(units, "Conditional: ifeq ($(OS),Windows_NT)");
    expect(conditional.kind).toBe("module");
    expect(conditional.source).toContain("Platform selection");
    expect(conditional.source).not.toContain("EXE :=");
    expect(conditional.dependencies).toEqual(
      expect.arrayContaining([
        ...units
          .filter(({ name }) => name === "EXE · simple")
          .map(({ stableKey }) => stableKey),
        ...units
          .filter(({ name }) => name === "run")
          .map(({ stableKey }) => stableKey),
      ]),
    );
    expect(units.filter(({ name }) => name === "EXE · simple")).toHaveLength(3);
    expect(units.filter(({ name }) => name === "run")).toHaveLength(2);
  });

  it("handles multiline declarations, custom recipe prefixes, and opaque recipes", () => {
    const units = analyze(`.RECIPEPREFIX := >

SOURCES := src/a.c \\
           src/b.c \\
           src/url:parser.c

build: dep-one \\
       dep-two
>printf '%s\\n' 'fake: target' 'VALUE := not-make' 'https://example.test:8443'
>echo escaped \\# hash

next: build
>echo done
`);

    expect(named(units, "SOURCES · simple").source).toContain(
      "src/url:parser.c",
    );
    const build = named(units, "build");
    expect(build.source).toContain("fake: target");
    expect(build.source).toContain("VALUE := not-make");
    expect(units.some(({ name }) => name === "fake")).toBe(false);
    expect(units.some(({ name }) => name === "VALUE · simple")).toBe(false);
    expect(named(units, "next").dependencies).toContain(build.stableKey);
  });

  it("does not confuse colons, escaped comments, or functions in values for rules", () => {
    const units = analyze(`IMAGE := registry.example:5000/reviewduck
HASH := value\\#fragment
CHOICE := $(if $(CI),release:ci,release:local)
URL = https://example.test:8443/api

print:
	@echo "$(IMAGE) $(HASH) $(CHOICE) $(URL)"
`);

    expect(named(units, "IMAGE · simple").source).toContain(":5000");
    expect(named(units, "HASH · simple").source).toContain("\\#fragment");
    expect(named(units, "CHOICE · simple").source).toContain("release:ci");
    expect(named(units, "URL").source).toContain("https://");
    expect(units.filter(({ kind }) => kind === "function")).toHaveLength(1);
    expect(named(units, "print").dependencies).toEqual(
      expect.arrayContaining([
        named(units, "IMAGE · simple").stableKey,
        named(units, "HASH · simple").stableKey,
        named(units, "CHOICE · simple").stableKey,
        named(units, "URL").stableKey,
      ]),
    );
  });

  it("treats comment and include-only preambles as context", () => {
    const context = `# Shared build configuration
include config/base.mk
-include $(wildcard config/local/*.mk)
sinclude generated/dependencies.mk
`;
    expect(isContextOnly(context)).toBe(true);
    expect(analyze(context)).toEqual([]);
    expect(isContextOnly(`${context}\n.DEFAULT_GOAL := all\n`)).toBe(false);
    expect(makefileAdapter.extensions).toBe(makefileExtensions);
    expect(makefileAdapter.fileNames).toBe(makefileFileNames);
    expect(makefileFileNames).toEqual(
      expect.arrayContaining(["makefile", "gnumakefile"]),
    );
  });
});
