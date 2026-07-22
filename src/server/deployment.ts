import "server-only";

import { env } from "~/env";
import type { DeploymentMode } from "~/lib/deployment";

/** Returns the explicitly configured application deployment mode. */
export function deploymentMode(): DeploymentMode {
  return env.DEPLOYMENT_MODE;
}

/** Returns whether this process is a trusted, single-user local installation. */
export function isLocalDeployment() {
  return deploymentMode() === "local";
}

/** Fails early when authenticated mode is missing Clerk configuration. */
export function assertAuthenticationConfigured() {
  if (isLocalDeployment()) return;
  const missing = [
    [
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    ],
    ["CLERK_SECRET_KEY", env.CLERK_SECRET_KEY],
    ["CLERK_WEBHOOK_SIGNING_SECRET", env.CLERK_WEBHOOK_SIGNING_SECRET],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Authenticated mode is missing required configuration: ${missing.join(", ")}`,
    );
  }
}
