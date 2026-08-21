/**
 * Why a changed file is not reviewed.
 *
 * `protected_path` and `secret_detected` are never returned by this module:
 * they are decided by `bigPickleSourceDecision` in `src/server/ai/source-policy.ts`,
 * which needs the hydrated source text, and are applied by the caller while
 * sealing the plan. They live in this union so every waived item carries one
 * reason vocabulary.
 */
export type ReviewExcludeReason =
  | "binary"
  | "no_source"
  | "generated"
  | "vendored"
  | "unsupported_extension"
  | "oversized"
  | "no_applicable_rule"
  | "protected_path"
  | "secret_detected";

export interface ReviewCandidateFile {
  path: string;
  changeType: string;
  isBinary: boolean;
  skipReason?: "too_large";
  /** From `source_blob.byteLength`; 0 when there is no current blob. */
  sourceBytes: number;
  hasCurrentSource: boolean;
  hasPreviousSource: boolean;
  changedLineCount: number;
}

export interface ReviewSelectionOptions {
  maxSourceBytes: number;
}

interface WaivedReviewFile {
  file: ReviewCandidateFile;
  reason: ReviewExcludeReason;
}

export interface ReviewSelection {
  selected: ReviewCandidateFile[];
  waived: WaivedReviewFile[];
}

/** The extensions a deep review will read. See ./rulebooks/NOTICE. */
export const SUPPORTED_REVIEW_EXTENSIONS: ReadonlySet<string> = new Set([
  "java",
  "kt",
  "kts",
  "scala",
  "groovy",
  "py",
  "pyi",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "c",
  "h",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "hxx",
  "cs",
  "vb",
  "fs",
  "go",
  "rs",
  "rb",
  "rake",
  "gemspec",
  "php",
  "phtml",
  "swift",
  "m",
  "mm",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "sql",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "ftl",
  "ftlh",
  "ftlx",
  "astro",
  "vue",
  "svelte",
  "xml",
  "yaml",
  "yml",
  "json",
  "toml",
  "ini",
  "env",
  "gradle",
  "cmake",
  "r",
  "lua",
  "pl",
  "pm",
  "ex",
  "exs",
  "erl",
  "hrl",
  "ets",
  "json5",
  "dart",
  "tf",
  "graphql",
  "gql",
  "prisma",
  "jl",
  "hcl",
  "tfvars",
  "bicep",
  "proto",
  "nix",
  "hs",
  "lhs",
  "nim",
  "nims",
  "nimble",
]);

/** The default exclude globs. See ./rulebooks/NOTICE. */
export const DEFAULT_REVIEW_EXCLUDE_PATTERNS: readonly string[] = [
  "**/*_test.go",
  "**/src/test/java/**/*.java",
  "**/src/test/**/*.kt",
  "**/*.test.{js,jsx,ts,tsx}",
  "**/*.spec.{js,jsx,ts,tsx}",
  "**/__tests__/**",
  "**/test/**/*_test.py",
  "**/tests/**/*_test.py",
  "**/*_test.py",
  "**/*_spec.rb",
  "**/spec/**/*_spec.rb",
  "**/*Test.java",
  "**/*Tests.java",
  "**/*_test.rs",
  "**/oh_modules/**",
  "**/*.test.ets",
  "**/test/**/*.jl",
  "**/test/**/*.hs",
  "**/*Spec.hs",
  "**/test/**/*.lhs",
  "**/*Spec.lhs",
  "**/tests/**/*.nim",
  "**/__snapshots__/**",
  "**/*.snap",
  "**/testdata/**",
  "**/fixtures/**",
  "**/*.generated.*",
  "**/*.gen.go",
  "**/*.pb.go",
  "**/*.pb.cc",
  "**/*.pb.h",
];

// The exclude corpus mixes three kinds of path. Machine-emitted output and
// inert test corpora are not worth a model turn, but hand-written test source
// is: a wrong assertion or a skipped case is a real defect, and neither
// "generated" nor "vendored" would be an honest waiver reason to show for
// `user_spec.rb`. So the test-source patterns are deliberately in neither
// subset and those files are reviewed.
const GENERATED_PATH_PATTERNS: readonly string[] = [
  "**/__snapshots__/**",
  "**/*.snap",
  "**/*.generated.*",
  "**/*.gen.go",
  "**/*.pb.go",
  "**/*.pb.cc",
  "**/*.pb.h",
];

// `node_modules` and `vendor` are absent here because they are absent from the
// ported corpus; the caller's `bigPickleSourceDecision` already refuses both as
// `protected_path`.
const VENDORED_PATH_PATTERNS: readonly string[] = [
  "**/oh_modules/**",
  "**/testdata/**",
  "**/fixtures/**",
];

/** Escapes the characters that carry meaning inside a regular expression. */
function escapeLiteral(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles one exclude glob into an anchored, case-insensitive expression.
 *
 * The corpus uses only `*`, a doubled star and `{a,b}`, matching upstream's
 * doublestar semantics: a doubled star spans zero or more path segments, so a
 * pattern rooted at one has to match a repository-root file as well as a
 * nested one.
 */
function globToRegExp(pattern: string) {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:[^/]*/)*";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (character === "{") {
      const close = pattern.indexOf("}", index);
      if (close > index) {
        const alternatives = pattern.slice(index + 1, close).split(",");
        source += `(?:${alternatives.map(escapeLiteral).join("|")})`;
        index = close + 1;
        continue;
      }
    }
    source += escapeLiteral(character ?? "");
    index += 1;
  }
  return new RegExp(`^${source}$`, "i");
}

const GENERATED_MATCHERS = GENERATED_PATH_PATTERNS.map(globToRegExp);
const VENDORED_MATCHERS = VENDORED_PATH_PATTERNS.map(globToRegExp);

/** Normalizes a repository path to the forward-slash form the globs assume. */
function normalizePath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Returns the lowercase extension without its dot, or null when there is none.
 *
 * A leading dot is a dotfile rather than an extension, so `.env` has no
 * extension while `local.env` has one.
 */
function pathExtension(path: string) {
  const separator = path.lastIndexOf("/");
  const basename = separator < 0 ? path : path.slice(separator + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return null;
  return basename.slice(dot + 1).toLowerCase();
}

/** Returns whether a path is machine-emitted output rather than authored code. */
export function isGeneratedPath(path: string) {
  const normalized = normalizePath(path);
  return GENERATED_MATCHERS.some((matcher) => matcher.test(normalized));
}

/** Returns whether a path holds third-party or inert fixture content. */
export function isVendoredPath(path: string) {
  const normalized = normalizePath(path);
  return VENDORED_MATCHERS.some((matcher) => matcher.test(normalized));
}

/**
 * Returns why a changed file is not reviewed, or null when it is.
 *
 * The ladder order is behaviour, not preference: binary before no_source so a
 * blobless image is reported as an image, extension before path so an excluded
 * `.txt` fixture is reported by its type. A deleted file is reviewed from its
 * previous revision, so `no_source` means neither revision has source, and
 * coverage is uncapped, so there is no cap reason.
 */
export function reviewExclusionReason(
  file: ReviewCandidateFile,
  options: ReviewSelectionOptions,
): ReviewExcludeReason | null {
  if (file.isBinary) return "binary";
  if (file.skipReason) return "oversized";
  if (!file.hasCurrentSource && !file.hasPreviousSource) return "no_source";
  const path = normalizePath(file.path);
  const extension = pathExtension(path);
  // An extensionless path is a Makefile, a Dockerfile or a shell script, all
  // of which are worth reviewing; only a known-unreviewable extension is
  // refused.
  if (extension !== null && !SUPPORTED_REVIEW_EXTENSIONS.has(extension)) {
    return "unsupported_extension";
  }
  if (isGeneratedPath(path)) return "generated";
  if (isVendoredPath(path)) return "vendored";
  // A deleted file carries no current blob and so is never oversized; its
  // previous revision is bounded by whatever the snapshot already stored.
  if (file.sourceBytes > options.maxSourceBytes) return "oversized";
  return null;
}

/** Partitions changed files into the reviewed set and the waived set. */
export function selectReviewFiles(
  files: readonly ReviewCandidateFile[],
  options: ReviewSelectionOptions,
): ReviewSelection {
  const selected: ReviewCandidateFile[] = [];
  const waived: WaivedReviewFile[] = [];
  for (const file of files) {
    const reason = reviewExclusionReason(file, options);
    if (reason === null) selected.push(file);
    else waived.push({ file, reason });
  }
  // Largest change first so the widest blast radius is dispatched first, then
  // path so a re-run of the same snapshot seals an identical plan.
  selected.sort((left, right) => {
    if (left.changedLineCount !== right.changedLineCount) {
      return right.changedLineCount - left.changedLineCount;
    }
    if (left.path === right.path) return 0;
    return left.path < right.path ? -1 : 1;
  });
  return { selected, waived };
}
