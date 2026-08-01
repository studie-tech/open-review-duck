import { createHmac } from "node:crypto";

const SECRET_FIELD =
  /authorization|cookie|token|secret|source|prompt|model.?output|signed.?url|file.?key|custom.?id|oauth.?code|request.?body|repository.?path/i;

/** Removes repository and credential material before an event leaves the process. */
export function redactSentryEvent<T>(value: T): T {
  if (!value) return value;
  const serialized = JSON.stringify(value, (key, nested) =>
    SECRET_FIELD.test(key) ? "[REDACTED]" : nested,
  );
  return JSON.parse(serialized) as T;
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

/** Adds a SaaS-only Sentry span without loading Sentry in the local target. */
export async function observeOperation<T>(
  name: string,
  op: string,
  operation: () => Promise<T>,
) {
  if (process.env.DEPLOYMENT_MODE !== "saas" || !process.env.SENTRY_DSN) {
    return operation();
  }
  const { startSpan } = await import("@sentry/nextjs");
  return startSpan({ name, op }, operation);
}

/** Sets a deployment-specific, irreversible SaaS user pseudonym. */
export async function setSentryUser(userId: string | null) {
  if (
    process.env.DEPLOYMENT_MODE !== "saas" ||
    !process.env.SENTRY_DSN ||
    !process.env.OAUTH_STATE_SECRET
  ) {
    return;
  }
  const { setUser } = await import("@sentry/nextjs");
  setUser(
    userId
      ? {
          id: createHmac("sha256", process.env.OAUTH_STATE_SECRET)
            .update("sentry-user\0")
            .update(userId)
            .digest("base64url"),
        }
      : null,
  );
}
