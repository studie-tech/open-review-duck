import "server-only";

import { createHash } from "node:crypto";

export interface RepositoryReviewRuleSnapshot {
  id: string;
  version: number;
  title: string;
  instruction: string;
  pathGlob: string;
  scope: "file" | "repository";
  severity: "critical" | "high" | "medium" | "low";
}

/** Escapes one literal glob character for a regular expression. */
function escapeLiteral(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compiles the small, portable glob dialect exposed by repository rules. */
export function repositoryRuleGlob(pattern: string) {
  const normalized = pattern.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  let source = "";
  let index = 0;
  while (index < normalized.length) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") {
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
      const close = normalized.indexOf("}", index);
      if (close > index) {
        const alternatives = normalized.slice(index + 1, close).split(",");
        source += `(?:${alternatives.map(escapeLiteral).join("|")})`;
        index = close + 1;
        continue;
      }
    }
    source += escapeLiteral(character ?? "");
    index += 1;
  }
  return new RegExp(`^${source}$`);
}

/**
 * Caches compiled globs by pattern.
 *
 * Callers match rules against every changed file in a review, so recompiling
 * one rule's glob per file turns the plan phase into O(files × rules) regex
 * builds for no benefit — a pattern compiles to exactly one matcher.
 */
const globCache = new Map<string, RegExp>();
const GLOB_CACHE_LIMIT = 512;

/** Compiles a rule glob once per distinct pattern. */
function cachedRuleGlob(pattern: string) {
  let glob = globCache.get(pattern);
  if (!glob) {
    glob = repositoryRuleGlob(pattern);
    if (globCache.size >= GLOB_CACHE_LIMIT) {
      const oldest = globCache.keys().next().value;
      if (oldest) globCache.delete(oldest);
    }
    globCache.set(pattern, glob);
  }
  return glob;
}

/** Selects immutable rules that apply to one path and execution scope. */
export function applicableRepositoryRules(
  rules: readonly RepositoryReviewRuleSnapshot[] | null | undefined,
  path: string,
  scope: RepositoryReviewRuleSnapshot["scope"],
) {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return (rules ?? []).filter(
    (rule) =>
      rule.scope === scope &&
      cachedRuleGlob(rule.pathGlob).test(normalizedPath),
  );
}

/** Produces the exact checklist given to a compliance agent. */
export function repositoryRulebookText(
  rules: readonly RepositoryReviewRuleSnapshot[],
) {
  if (rules.length === 0) {
    return "No compliance rules apply to this scope. Do not report style or policy findings.";
  }
  return rules
    .map(
      (rule, index) =>
        `${index + 1}. [${rule.severity.toUpperCase()}] ${rule.title}\n${rule.instruction}`,
    )
    .join("\n\n");
}

/** Hashes sorted immutable rule copies so review reuse never crosses versions. */
export function repositoryRuleDigest(
  rules: readonly RepositoryReviewRuleSnapshot[],
) {
  // A byte-wise comparator keeps the order — and therefore the digest —
  // identical across runtimes regardless of their ICU collation tables.
  const stable = [...rules]
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    .map((rule) => ({
      id: rule.id,
      version: rule.version,
      title: rule.title,
      instruction: rule.instruction,
      pathGlob: rule.pathGlob,
      scope: rule.scope,
      severity: rule.severity,
    }));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
