import { clerkMiddleware } from "@clerk/nextjs/server";

/** Applies Clerk authentication and security headers to SaaS requests. */
export const deploymentProxy = clerkMiddleware({
  contentSecurityPolicy: {
    strict: true,
    directives: {
      "base-uri": ["'self'"],
      "frame-ancestors": ["'none'"],
      "object-src": ["'none'"],
    },
  },
});
