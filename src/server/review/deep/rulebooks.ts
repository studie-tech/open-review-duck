import {
  compileRepositoryGlob,
  normalizeRepositoryPath,
} from "./repository-glob";
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
  matches: compileRepositoryGlob(pattern),
  extensionOnly: isExtensionPattern(pattern),
  pattern,
  name,
}));

/**
 * Resolves the rulebooks that apply to one changed file.
 *
 * Upstream takes the first pattern that matches in authored document order and
 * stops, which is why the order in system-rules.json is preserved rather than
 * sorted. We keep that for the primary slot and additionally resolve the
 * extension rulebook, so a workflow file is reviewed as both.
 */
export function resolveRulebooks(path: string): ResolvedRulebooks {
  const normalized = normalizeRepositoryPath(path);
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
