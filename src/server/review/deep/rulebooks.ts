import {
  RULEBOOK_DEFAULT,
  RULEBOOK_DIGEST,
  RULEBOOK_DOCUMENTS,
  RULEBOOK_PATTERNS,
} from "./rulebooks/corpus.generated";

export interface ResolvedRulebooks {
  /** The most specific rulebook, by authored pattern order. */
  primary: string;
  /**
   * The plain-extension rulebook, when a path-shaped pattern won the primary
   * slot. A GitHub workflow is both a workflow and YAML, and the two rulebooks
   * carry different checks.
   */
  secondary: string | null;
  names: readonly string[];
  text: string;
}

/** Escapes the characters that carry meaning inside a regular expression. */
function escapeLiteral(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles one glob into an anchored, case-insensitive expression.
 *
 * The vendored corpus uses only star, double-star and brace alternation,
 * matching upstream's doublestar semantics. Double-star followed by a separator
 * spans zero or more path segments, so an extension pattern has to match a
 * repository-root file as well as a nested one.
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
    if (character === "?") {
      source += "[^/]";
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

/**
 * Returns whether a pattern selects purely on file extension.
 *
 * Extension-only patterns are the language rulebooks; anything carrying a
 * directory or a literal file name is a framework or configuration rulebook,
 * and the two are resolved into separate slots.
 */
function isExtensionPattern(pattern: string) {
  return pattern.startsWith("**/*.") && !pattern.slice(4).includes("/");
}

const compiled = RULEBOOK_PATTERNS.map(([pattern, name]) => ({
  matches: globToRegExp(pattern),
  extensionOnly: isExtensionPattern(pattern),
  pattern,
  name,
}));

/** Normalizes a repository path for matching against the vendored globs. */
function normalizePath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Resolves the rulebooks that apply to one changed file.
 *
 * Upstream takes the first pattern that matches in authored document order and
 * stops, which is why the order in system-rules.json is preserved rather than
 * sorted. We keep that for the primary slot and additionally resolve the
 * extension rulebook, so a workflow file is reviewed as both.
 */
export function resolveRulebooks(path: string): ResolvedRulebooks {
  const normalized = normalizePath(path);
  const primaryMatch = compiled.find((entry) => entry.matches.test(normalized));
  const primary = primaryMatch?.name ?? RULEBOOK_DEFAULT;
  const extensionMatch = primaryMatch?.extensionOnly
    ? undefined
    : compiled.find(
        (entry) => entry.extensionOnly && entry.matches.test(normalized),
      );
  const secondary =
    extensionMatch && extensionMatch.name !== primary
      ? extensionMatch.name
      : null;
  const names = secondary ? [primary, secondary] : [primary];
  return {
    primary,
    secondary,
    names,
    text: names
      .map((name) => RULEBOOK_DOCUMENTS[name])
      .filter((document): document is string => Boolean(document))
      .join("\n\n"),
  };
}

/** Identifies the vendored corpus so cached findings invalidate when it changes. */
export function rulebookCorpusDigest() {
  return RULEBOOK_DIGEST;
}
