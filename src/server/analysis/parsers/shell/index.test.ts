import { describe, expect, it } from "vitest";
import type { SourceFile } from "../../types";
import {
  isContextOnly,
  shellAdapter,
  shellExtensions,
  shellFileNames,
  shellParserInternals,
} from ".";

/** Analyzes an in-memory shell fixture. */
function analyze(content: string, path = "scripts/release.sh") {
  return shellAdapter.analyze({ path, content, changeType: "added" });
}

/** Returns a fixture unit by name with a useful assertion failure. */
function named(units: ReturnType<typeof analyze>, name: string) {
  const unit = units.find((candidate) => candidate.name === name);
  expect(
    unit,
    `Expected ${name}; received ${units.map((candidate) => `${candidate.kind}:${candidate.name}`).join(", ")}`,
  ).toBeDefined();
  if (!unit) throw new Error(`Missing unit ${name}`);
  return unit;
}

describe("shell review analysis", () => {
  it("extracts documented functions and keeps top-level script flows cohesive", () => {
    const units = analyze(`#!/usr/bin/env bash
source "./lib/logging.sh"

# Maximum attempts for a release.
readonly DEFAULT_RETRIES=3
export API_URL="https://example.test"
cache_dir=\${XDG_CACHE_HOME:-/tmp}/reviewduck
artifacts=(dist/*.tgz dist/*.zip)

# Formats a release name for display.
format_name() {
  printf '%s' "\${1//_/-}"
}

# Publishes prepared artifacts.
function publish {
  local display
  source "./lib/uploader.sh"
  display=$(format_name "$1")
  upload "$display"
}

# Restore temporary files when interrupted.
trap 'rm -rf "$work_dir"' EXIT INT TERM
set -euo pipefail

# Build release artifacts
prepare_dist
publish "nightly_build"
`);

    expect(units.map(({ name }) => name)).not.toContain("./lib/logging.sh");
    const setup = named(units, "Script setup");
    expect(setup.kind).toBe("module");
    expect(setup.source).toContain("Maximum attempts");
    expect(setup.source).toContain("readonly DEFAULT_RETRIES=3");
    expect(setup.source).toContain("artifacts=(dist/*.tgz dist/*.zip)");

    const format = named(units, "format_name");
    expect(format.kind).toBe("function");
    expect(format.source).toContain("Formats a release name");
    const publish = named(units, "publish");
    expect(publish.dependencies).toEqual(
      expect.arrayContaining([
        format.stableKey,
        "shell-source:./lib/logging.sh",
        "shell-source:./lib/uploader.sh",
      ]),
    );

    const execution = named(units, "Script execution");
    expect(execution.source).toContain("trap");
    expect(execution.source).toContain("set -euo pipefail");
    expect(execution.source).toContain("prepare_dist");
    expect(execution.source).toContain('publish "nightly_build"');
    expect(execution.dependencies).toContain(publish.stableKey);
    expect(units).toHaveLength(4);
  });

  it("handles heredocs, substitutions, arrays, continuations, and misleading delimiters", () => {
    const units = analyze(`render() {
  local value="\${1:-{fallback}}"
  cat <<'TEMPLATE'
fake() {
  echo "this } is inert"
}
TEMPLATE
  printf '%s\\n' "$value"
}

FILES=(
  "one.sh"
  "two.sh"
)

message="function nope() { } # not syntax"

after() {
  render "$(printf '%s' '}')"
}
`);

    expect(named(units, "render").source).toContain("TEMPLATE");
    expect(units.some(({ name }) => name === "fake")).toBe(false);
    expect(units.some(({ name }) => name === "nope")).toBe(false);
    const flow = named(units, "Script flow");
    expect(flow.kind).toBe("module");
    expect(flow.source).toContain("FILES=(");
    expect(flow.source).toContain('message="function nope()');
    expect(named(units, "after").dependencies).toContain(
      named(units, "render").stableKey,
    );
    expect(
      shellParserInternals.maskShellSource(`cat <<EOF\n}\nEOF\n`),
    ).toHaveLength(`cat <<EOF\n}\nEOF\n`.length);
  });

  it("splits Bats tests and lifecycle hooks while retaining helper dependencies", () => {
    const units = analyze(
      `#!/usr/bin/env bats
helper() { printf 'ready'; }

setup() {
  export WORK_DIR="$BATS_TEST_TMPDIR/work"
}

teardown_file() {
  rm -rf "$WORK_DIR"
}

@test "publishes an artifact" {
  run helper
  [ "$status" -eq 0 ]
}

@test 'handles a literal } brace' {
  run helper
}
`,
      "test/release.bats",
    );

    const helper = named(units, "helper");
    expect(named(units, "setup").kind).toBe("test_hook");
    expect(named(units, "teardown_file").kind).toBe("test_hook");
    const publishes = named(units, "publishes an artifact");
    expect(publishes.kind).toBe("test");
    expect(publishes.dependencies).toContain(helper.stableKey);
    expect(named(units, "handles a literal } brace").kind).toBe("test");
  });

  it("recognizes shunit2 tests without treating production hooks as tests", () => {
    const testUnits = analyze(
      `setUp() { fixture="ready"; }
tearDown() { fixture=""; }
testPublishesArtifact() { assertEquals "ready" "$fixture"; }
`,
      "tests/publisher_test.sh",
    );
    expect(named(testUnits, "setUp").kind).toBe("test_hook");
    expect(named(testUnits, "tearDown").kind).toBe("test_hook");
    expect(named(testUnits, "testPublishesArtifact").kind).toBe("test");

    const production = analyze(`setup() { start_server; }`, "bin/server.sh");
    expect(named(production, "setup").kind).toBe("function");
  });

  it("keeps the complete top-level execution flow together", () => {
    const units = analyze(`helper() { printf 'ok'; }

# Dispatch by mode
case "$mode" in
  if)
    printf 'keyword-shaped case label'
    ;;
  *)
    if enabled; then

      helper
    fi
    ;;
esac

# Finalize release
finalize
`);
    const execution = named(units, "Script execution");
    expect(execution.source).toContain("case");
    expect(execution.source).toContain("esac");
    expect(execution.source).toContain("finalize");
    expect(execution.dependencies).toContain(named(units, "helper").stableKey);
    expect(units).toHaveLength(2);
  });

  it("reduces an entrypoint to setup, named functions, and one execution flow", () => {
    const units = analyze(`#!/bin/sh
set -eu

postgres_bin=""
for candidate in /usr/lib/postgresql/*/bin; do
  if [ -x "$candidate/postgres" ]; then
    postgres_bin="$candidate"
    break
  fi
done
postgres_data="\${DATA_DIR:-/data}/postgres"

install -d -m 0700 "$postgres_data"
if [ ! -s "$postgres_data/PG_VERSION" ]; then
  initialize_database
fi

shutdown() {
  stop_services
}

graceful_shutdown() {
  trap - INT TERM EXIT
  shutdown
  exit 0
}

trap graceful_shutdown INT TERM
trap shutdown EXIT
start_database
start_services
while services_are_running; do
  sleep 1
done
`);

    expect(units.map(({ name }) => name)).toEqual([
      "Script setup",
      "shutdown",
      "graceful_shutdown",
      "Script execution",
    ]);
    expect(named(units, "Script setup").source).toContain("postgres_data=");
    expect(named(units, "Script execution").dependencies).toEqual(
      expect.arrayContaining([
        named(units, "shutdown").stableKey,
        named(units, "graceful_shutdown").stableKey,
      ]),
    );
  });

  it("keeps pure source preambles as context but reviews executable source guards", () => {
    const context = `#!/usr/bin/env zsh
# shellcheck source=./lib/common.sh
source "./lib/common.sh"
. "\${0:A:h}/env.sh"
`;
    expect(isContextOnly(context)).toBe(true);
    expect(
      shellAdapter.analyze({
        path: ".zshrc",
        content: context,
      } satisfies SourceFile),
    ).toEqual([]);
    expect(isContextOnly("source ./optional.sh || exit 1\n")).toBe(false);
    expect(analyze("source ./optional.sh || exit 1\n")).toHaveLength(1);
  });

  it("exposes the configured extensions and conventional shell filenames", () => {
    expect(shellAdapter.extensions).toBe(shellExtensions);
    expect(shellAdapter.fileNames).toBe(shellFileNames);
    expect(shellFileNames).toEqual(
      expect.arrayContaining([".bashrc", ".zshrc", ".profile"]),
    );
  });
});
