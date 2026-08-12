const fallbackReason = "An unexpected error occurred";
const placeholder = "[REDACTED]";
const defaultMaxLength = 500;

interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

// Ordered: each rule assumes the ones above it already claimed the broader
// shapes, so a secret can never be split between two partial matches.
const redactionRules: RedactionRule[] = [
  {
    // Userinfo goes first. Left alone it reads as an ordinary host to every
    // rule below, and the bare host is what we want to keep for diagnostics.
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi,
    replacement: "$1REDACTED@",
  },
  {
    // The whole header value, scheme included, before any narrower rule can
    // consume only the scheme word and leave the credential behind.
    pattern:
      /\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)?\s*[^\s"',;]*/gi,
    replacement: `Authorization: ${placeholder}`,
  },
  {
    pattern: /\b(bearer|basic)\s+[A-Za-z0-9\-._~+/]{8,}={0,2}/gi,
    replacement: `$1 ${placeholder}`,
  },
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replacement: placeholder,
  },
  {
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/g,
    replacement: placeholder,
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}/g,
    replacement: placeholder,
  },
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: placeholder,
  },
  {
    // A JWT header always base64url-encodes `{"`, so this catches signed and
    // unsigned tokens alike without guessing at segment lengths.
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g,
    replacement: placeholder,
  },
  {
    // Any three long base64url segments. The 16-character floor keeps dotted
    // hostnames and version strings readable.
    pattern: /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
    replacement: placeholder,
  },
  {
    // Before the assignment rule, so a query value stops at `&` instead of
    // swallowing every remaining parameter.
    pattern:
      /([?&][^\s&=#]*(?:key|token|secret|password|signature)[^\s&=#]*=)[^&\s#]*/gi,
    replacement: `$1${placeholder}`,
  },
  {
    // The placeholder is its own value alternative: the bare-value class stops
    // at `]`, which would otherwise clip a replacement an earlier rule wrote.
    pattern:
      /\b((?:api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|token|secret|password|passwd|pwd)["']?\s*[:=]\s*)(?:\[REDACTED\]|"[^"]*"|'[^']*'|[^\s,;)}\]&"']+)/gi,
    replacement: `$1${placeholder}`,
  },
];

/** Reads the text a reason may derive from, never a stack or a foreign shape. */
function toRawReason(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return String(value.message ?? "");
  return "";
}

/** Clamps a caller-supplied budget into a usable positive integer length. */
function toMaxLength(maxLength: number | undefined): number {
  if (typeof maxLength !== "number" || !Number.isFinite(maxLength)) {
    return defaultMaxLength;
  }
  return Math.max(1, Math.floor(maxLength));
}

/** Applies every redaction rule in order to normalized single-line text. */
function redact(text: string): string {
  return redactionRules.reduce(
    (current, rule) => current.replace(rule.pattern, rule.replacement),
    text,
  );
}

/** Reduces a provider error or model output to a redacted, bounded reason. */
export function sanitizeReason(
  value: unknown,
  options?: { maxLength?: number },
): string {
  const maxLength = toMaxLength(options?.maxLength);
  const collapsed = toRawReason(value).replace(/\s+/g, " ").trim();
  if (!collapsed) return fallbackReason;
  // Redaction precedes truncation so a cut can never expose the readable head
  // of a secret the rules would otherwise have replaced whole.
  const redacted = redact(collapsed).replace(/\s+/g, " ").trim();
  if (!redacted) return fallbackReason;
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength - 1).trimEnd()}…`;
}
