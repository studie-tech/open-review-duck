import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_EXCLUDE_PATTERNS,
  isGeneratedPath,
  isVendoredPath,
  type ReviewCandidateFile,
  reviewExclusionReason,
  SUPPORTED_REVIEW_EXTENSIONS,
  selectReviewFiles,
} from "./selection";

const options = { maxSourceBytes: 200_000 };

/** Builds one changed file, defaulting to an ordinary reviewable modification. */
function candidate(
  overrides: Partial<ReviewCandidateFile> & { path: string },
): ReviewCandidateFile {
  return {
    changeType: "MODIFIED",
    isBinary: false,
    sourceBytes: 1_000,
    hasCurrentSource: true,
    hasPreviousSource: true,
    changedLineCount: 10,
    ...overrides,
  };
}

describe("deep review file selection", () => {
  it("reviews an ordinary source file", () => {
    expect(
      reviewExclusionReason(
        candidate({ path: "src/server/queue.ts" }),
        options,
      ),
    ).toBeNull();
  });

  it("reports binary ahead of every other reason it also qualifies for", () => {
    const file = candidate({
      path: "docs/architecture.png",
      isBinary: true,
      hasCurrentSource: false,
      hasPreviousSource: false,
      sourceBytes: 900_000,
    });
    expect(reviewExclusionReason(file, options)).toBe("binary");
  });

  it("reports no_source ahead of an unsupported extension", () => {
    const file = candidate({
      path: "docs/notes.md",
      hasCurrentSource: false,
      hasPreviousSource: false,
    });
    expect(reviewExclusionReason(file, options)).toBe("no_source");
  });

  it("reports an unsupported extension ahead of a generated path", () => {
    const file = candidate({ path: "docs/api.generated.md" });
    expect(reviewExclusionReason(file, options)).toBe("unsupported_extension");
    expect(isGeneratedPath(file.path)).toBe(true);
  });

  it("reports generated ahead of vendored", () => {
    const file = candidate({ path: "internal/testdata/schema.generated.go" });
    expect(reviewExclusionReason(file, options)).toBe("generated");
    expect(isVendoredPath(file.path)).toBe(true);
  });

  it("reports vendored ahead of oversized", () => {
    const file = candidate({
      path: "test/fixtures/users.json",
      sourceBytes: 5_000_000,
    });
    expect(reviewExclusionReason(file, options)).toBe("vendored");
  });

  it("reports oversized only when nothing earlier applies", () => {
    const file = candidate({ path: "src/schema.ts", sourceBytes: 200_001 });
    expect(reviewExclusionReason(file, options)).toBe("oversized");
    expect(
      reviewExclusionReason({ ...file, sourceBytes: 200_000 }, options),
    ).toBeNull();
  });

  it("reviews a deleted file from its previous revision", () => {
    const deleted = candidate({
      path: "src/server/auth/require-session.ts",
      changeType: "DELETED",
      hasCurrentSource: false,
      hasPreviousSource: true,
      sourceBytes: 0,
    });
    expect(reviewExclusionReason(deleted, options)).toBeNull();
  });

  it("waives no_source only when neither revision has source", () => {
    const added = candidate({
      path: "src/new.ts",
      changeType: "ADDED",
      hasPreviousSource: false,
    });
    expect(reviewExclusionReason(added, options)).toBeNull();
    expect(
      reviewExclusionReason(
        { ...added, hasCurrentSource: false, sourceBytes: 0 },
        options,
      ),
    ).toBe("no_source");
  });

  it("reviews an extensionless script", () => {
    for (const path of ["Makefile", "Dockerfile", "scripts/release"]) {
      expect(reviewExclusionReason(candidate({ path }), options)).toBeNull();
    }
  });

  it("treats a leading dot as a dotfile rather than an extension", () => {
    expect(
      reviewExclusionReason(candidate({ path: ".env" }), options),
    ).toBeNull();
    expect(
      reviewExclusionReason(candidate({ path: "config/local.env" }), options),
    ).toBeNull();
    expect(
      reviewExclusionReason(candidate({ path: "pnpm-lock.yaml" }), options),
    ).toBeNull();
    expect(
      reviewExclusionReason(candidate({ path: "bun.lock" }), options),
    ).toBe("unsupported_extension");
  });

  it("matches extensions case-insensitively", () => {
    expect(
      reviewExclusionReason(candidate({ path: "cmd/Main.GO" }), options),
    ).toBeNull();
  });

  it("normalizes windows separators before matching a path", () => {
    expect(isGeneratedPath("api\\v1\\service.pb.go")).toBe(true);
    expect(isVendoredPath(".\\entry\\oh_modules\\lib\\index.ets")).toBe(true);
  });

  it("never caps the number of reviewed files", () => {
    const files = Array.from({ length: 500 }, (_, index) =>
      candidate({ path: `src/module-${index}.ts` }),
    );
    const { selected, waived } = selectReviewFiles(files, options);
    expect(selected).toHaveLength(500);
    expect(waived).toHaveLength(0);
  });

  it("orders selection by descending change size, then by path", () => {
    const { selected } = selectReviewFiles(
      [
        candidate({ path: "src/b.ts", changedLineCount: 5 }),
        candidate({ path: "src/a.ts", changedLineCount: 5 }),
        candidate({ path: "src/z.ts", changedLineCount: 40 }),
      ],
      options,
    );
    expect(selected.map((file) => file.path)).toEqual([
      "src/z.ts",
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("waives every excluded file with its reason instead of dropping it", () => {
    const files = [
      candidate({ path: "src/app.ts" }),
      candidate({ path: "assets/logo.png", isBinary: true }),
      candidate({ path: "api/v1/service.pb.go" }),
      candidate({ path: "README.md" }),
    ];
    const { selected, waived } = selectReviewFiles(files, options);
    expect(selected.map((file) => file.path)).toEqual(["src/app.ts"]);
    expect(waived.map((entry) => [entry.file.path, entry.reason])).toEqual([
      ["assets/logo.png", "binary"],
      ["api/v1/service.pb.go", "generated"],
      ["README.md", "unsupported_extension"],
    ]);
    expect(selected.length + waived.length).toBe(files.length);
  });
});

describe("deep review path classification", () => {
  it("recognises generated output across the ported patterns", () => {
    for (const path of [
      "api/types.generated.go",
      "src/graphql/schema.generated.ts",
      "proto/message.gen.go",
      "api/v1/service.pb.go",
      "proto/message.pb.cc",
      "proto/message.pb.h",
      "src/__snapshots__/App.test.js.snap",
      "packages/ui/src/components/Button.snap",
    ]) {
      expect(isGeneratedPath(path)).toBe(true);
    }
  });

  it("recognises vendored and fixture trees", () => {
    for (const path of [
      "oh_modules/some_lib/index.ets",
      "entry/oh_modules/lib/index.ets",
      "internal/parser/testdata/input.json",
      "pkg/a/b/testdata/golden.txt",
      "test/fixtures/sample.json",
      "spec/fixtures/users.yml",
    ]) {
      expect(isVendoredPath(path)).toBe(true);
    }
  });

  it("does not classify a directory or file that merely shares the word", () => {
    for (const path of [
      "src/generated/code.go",
      "src/gen/util.go",
      "src/pb/client.go",
      "src/snapshots/util.ts",
      "src/testdata.go",
      "src/fixtures.ts",
      "src/server/queue.ts",
    ]) {
      expect(isGeneratedPath(path)).toBe(false);
      expect(isVendoredPath(path)).toBe(false);
    }
  });

  it("reviews hand-written test source", () => {
    for (const path of [
      "src/server/review/deep/selection.test.ts",
      "internal/agent/preview_test.go",
      "app/models/user_spec.rb",
      "src/test/java/com/example/FooTest.java",
      "packages/ui/__tests__/Button.test.tsx",
    ]) {
      expect(reviewExclusionReason(candidate({ path }), options)).toBeNull();
    }
  });
});

describe("deep review allowlist corpus", () => {
  it("carries the extension allowlist, lowercase and undotted", () => {
    expect(SUPPORTED_REVIEW_EXTENSIONS.size).toBe(86);
    for (const extension of ["go", "ts", "tsx", "ets", "nimble", "bicep"]) {
      expect(SUPPORTED_REVIEW_EXTENSIONS.has(extension)).toBe(true);
    }
    for (const extension of ["md", "txt", "png", "lock", ".go", "GO"]) {
      expect(SUPPORTED_REVIEW_EXTENSIONS.has(extension)).toBe(false);
    }
  });

  it("carries every exclude pattern verbatim", () => {
    expect(DEFAULT_REVIEW_EXCLUDE_PATTERNS).toHaveLength(31);
    expect(DEFAULT_REVIEW_EXCLUDE_PATTERNS).toContain("**/*_test.go");
    expect(DEFAULT_REVIEW_EXCLUDE_PATTERNS).toContain(
      "**/*.test.{js,jsx,ts,tsx}",
    );
    expect(DEFAULT_REVIEW_EXCLUDE_PATTERNS).toContain("**/oh_modules/**");
    expect(DEFAULT_REVIEW_EXCLUDE_PATTERNS).toContain("**/*.pb.h");
    expect(new Set(DEFAULT_REVIEW_EXCLUDE_PATTERNS).size).toBe(
      DEFAULT_REVIEW_EXCLUDE_PATTERNS.length,
    );
  });

  it("classifies only paths the ported corpus covers", () => {
    // node_modules and vendor are absent upstream; source-policy refuses them.
    expect(isVendoredPath("node_modules/react/index.js")).toBe(false);
    expect(isVendoredPath("vendor/github.com/pkg/errors/errors.go")).toBe(
      false,
    );
  });
});
