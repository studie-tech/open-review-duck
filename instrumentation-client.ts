import * as Sentry from "@sentry/nextjs";

if (
  process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === "saas" &&
  process.env.NEXT_PUBLIC_SENTRY_DSN
) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    enableLogs: true,
    profilesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    sendDefaultPii: false,
    tracesSampler: ({ name }) => {
      if (name.includes("/health") || name.includes("/tree-sitter/")) return 0;
      if (
        name.includes("/api/integrations/") ||
        name.includes("/api/webhooks/") ||
        name.includes("/api/ai/") ||
        name.includes("/api/trpc")
      ) {
        return 0.1;
      }
      return 0.01;
    },
    beforeSend(event) {
      return redactSentryEvent(event);
    },
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === "console" && breadcrumb.level === "debug") {
        return null;
      }
      return redactSentryEvent(breadcrumb);
    },
    integrations: [],
  });
}

/** Recursively strips sensitive client telemetry fields before transport. */
function redactSentryEvent<T>(value: T): T {
  const serialized = JSON.stringify(value, (key, nested) => {
    if (
      /authorization|cookie|token|secret|source|prompt|output|signed.?url|file.?key|custom.?id|oauth.?code|request.?body/i.test(
        key,
      )
    ) {
      return "[REDACTED]";
    }
    return nested;
  });
  return JSON.parse(serialized) as T;
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
