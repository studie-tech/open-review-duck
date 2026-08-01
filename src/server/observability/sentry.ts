import "server-only";

import { createHmac } from "node:crypto";

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
