const SENSITIVE_FIELD =
  /authorization|cookie|token|secret|source|prompt|output|signed.?url|file.?key|custom.?id|oauth.?code|request.?body|repository.?path/i;
const SENSITIVE_ROUTE = /\/api\/(?:integrations|webhooks)\//i;
const ROUTE_PAYLOAD_FIELD =
  /(?:^|[._-])(?:body|data|query|query_string|querystring)(?:$|[._-])/i;

/** Removes query credentials from integration and webhook URLs. */
function sanitizedUrl(value: string) {
  if (!SENSITIVE_ROUTE.test(value)) return value;
  try {
    const url = new URL(value, "https://redaction.invalid");
    return url.origin === "https://redaction.invalid"
      ? url.pathname
      : `${url.origin}${url.pathname}`;
  } catch {
    return "[REDACTED]";
  }
}

/** Removes route-contextual request data after field-level redaction. */
function redactSensitiveRoutes(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) redactSensitiveRoutes(item);
    return;
  }
  const record = value as Record<string, unknown>;
  let sensitiveRouteContext = false;
  for (const [key, nested] of Object.entries(record)) {
    if (typeof nested === "string" && SENSITIVE_ROUTE.test(nested)) {
      sensitiveRouteContext = true;
      record[key] = sanitizedUrl(nested);
    }
  }
  for (const [key, nested] of Object.entries(record)) {
    if (sensitiveRouteContext && ROUTE_PAYLOAD_FIELD.test(key)) {
      record[key] = "[REDACTED]";
    } else {
      redactSensitiveRoutes(nested);
    }
  }
}

/** Removes repository and credential material before an event leaves the process. */
export function redactSentryEvent<T>(value: T): T {
  if (value == null) return value;

  const serialized = JSON.stringify(value, (key, nested) =>
    SENSITIVE_FIELD.test(key) ? "[REDACTED]" : nested,
  );
  if (serialized === undefined) return value;
  const redacted = JSON.parse(serialized) as T;
  redactSensitiveRoutes(redacted);
  return redacted;
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
