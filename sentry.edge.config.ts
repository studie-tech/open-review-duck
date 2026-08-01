import * as Sentry from "@sentry/nextjs";
import {
  redactSentryEvent,
  tracesSampler,
} from "./src/server/observability/sentry";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  enableLogs: true,
  sendDefaultPii: false,
  tracesSampler,
  beforeSend: redactSentryEvent,
  beforeSendTransaction: redactSentryEvent,
  beforeSendSpan: redactSentryEvent,
  beforeBreadcrumb: redactSentryEvent,
});
