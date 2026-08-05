import { clerkMiddleware } from "@clerk/nextjs/server";
import { env } from "~/env";
import { PRIVATE_SOURCE_CONNECT_ORIGIN } from "~/lib/content-security-policy";
import { sentryIngestOrigin } from "~/lib/sentry-safety";

const sentryOrigin = sentryIngestOrigin(env.NEXT_PUBLIC_SENTRY_DSN);

/** Applies Clerk authentication and security headers to SaaS requests. */
export const deploymentProxy = clerkMiddleware({
  contentSecurityPolicy: {
    strict: true,
    directives: {
      "base-uri": ["'self'"],
      "connect-src": [
        "'self'",
        PRIVATE_SOURCE_CONNECT_ORIGIN,
        ...(sentryOrigin ? [sentryOrigin] : []),
      ],
      "frame-ancestors": ["'none'"],
      "object-src": ["'none'"],
      "script-src": ["'wasm-unsafe-eval'"],
    },
  },
});
