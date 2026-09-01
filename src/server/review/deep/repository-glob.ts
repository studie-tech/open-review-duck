/** Escapes characters that carry meaning inside a regular expression. */
function escapeLiteral(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles a repository-relative glob into an anchored expression.
 *
 * Matching is case-insensitive. A single star stays within one path segment,
 * `?` consumes one non-separator character, and a doubled star can cross path
 * separators. A doubled star followed by `/` consumes zero or more complete
 * segments, so a root-recursive extension pattern selects files at both the
 * repository root and in nested directories.
 * Brace groups are literal alternatives, as used by the rulebook corpus.
 */
export function compileRepositoryGlob(pattern: string) {
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

/** Normalizes a repository path to the relative forward-slash form globs use. */
export function normalizeRepositoryPath(path: string) {
  return path.replaceAll("\\", "/").replace(/^(?:\.\/|\/)+/, "");
}
