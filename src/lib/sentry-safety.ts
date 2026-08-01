const SENSITIVE_FIELD =
  /authorization|cookie|token|secret|source|prompt|output|signed.?url|file.?key|custom.?id|oauth.?code|request.?body|repository.?path/i;

/** Removes repository and credential material before an event leaves the process. */
export function redactSentryEvent<T>(value: T): T {
  if (value == null) return value;

  const serialized = JSON.stringify(value, (key, nested) =>
    SENSITIVE_FIELD.test(key) ? "[REDACTED]" : nested,
  );
  return serialized === undefined ? value : (JSON.parse(serialized) as T);
}

/** Applies the production trace budget to high-value and ordinary operations. */
export function tracesSampler(context: { name?: string }) {
  const name = context.name ?? "";
  if (
    name.includes("/health") ||
    name.includes("/_next/") ||
    name.includes("/tree-sitter/")
  ) {
    return 0;
  }
  if (
    /sync|workflow|\/api\/ai\/|\/api\/webhooks\/|\/api\/integrations\/|billing/i.test(
      name,
    )
  ) {
    return 0.1;
  }
  return 0.01;
}
