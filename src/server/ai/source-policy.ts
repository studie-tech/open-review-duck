import ignore from "ignore";

const excludedPathParts = new Set([
  ".env",
  ".git",
  ".idea",
  ".next",
  ".npmrc",
  ".pnpm-store",
  ".ssh",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\n]{12,}["']/i,
];

/** Returns whether source may be transmitted through the free Big Pickle tier. */
export function bigPickleSourceDecision(path: string, source: string) {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (
    parts.some((part) => excludedPathParts.has(part.toLowerCase())) ||
    /\.pem$|\.key$|\.p12$|\.pfx$|credentials|secrets?/i.test(normalized)
  ) {
    return { allowed: false as const, reason: "protected_path" as const };
  }
  if (secretPatterns.some((pattern) => pattern.test(source))) {
    return { allowed: false as const, reason: "secret_detected" as const };
  }
  if (source.includes("\0")) {
    return { allowed: false as const, reason: "binary" as const };
  }
  return { allowed: true as const };
}

/** Builds a conservative matcher for repository and nested AI ignore files. */
export function bigPickleIgnoreMatcher(
  files: Array<{ path: string; source: string }>,
) {
  const matchers = files.map((file) => {
    const normalized = file.path.replaceAll("\\", "/");
    const separator = normalized.lastIndexOf("/");
    const base = separator < 0 ? "" : normalized.slice(0, separator + 1);
    return { base, matcher: ignore().add(file.source) };
  });
  return (path: string) => {
    const normalized = path.replaceAll("\\", "/");
    return matchers.some(({ base, matcher }) => {
      if (!normalized.startsWith(base)) return false;
      const relative = normalized.slice(base.length);
      return Boolean(relative) && matcher.ignores(relative);
    });
  };
}
