import "server-only";

import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { localSessions } from "@/drizzle/schema";
import { LOCAL_SESSION_COOKIE } from "~/lib/deployment";
import { db } from "~/server/db";
import {
  assertDeploymentConfigured,
  isLocalDeployment,
} from "~/server/deployment";
import { setSentryUser } from "~/server/observability/sentry";

export interface ApplicationAuth {
  userId: string | null;
  has(input: { feature: string }): boolean;
}

/** Resolves either Clerk authorization or the isolated local identity. */
async function resolveApplicationAuth(): Promise<ApplicationAuth> {
  assertDeploymentConfigured();
  if (isLocalDeployment()) {
    const token = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value;
    if (!token) return { userId: null, has: () => false };
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const session = await db.query.localSessions.findFirst({
      where: and(
        eq(localSessions.tokenHash, tokenHash),
        isNull(localSessions.revokedAt),
        gt(localSessions.expiresAt, new Date()),
      ),
    });
    return { userId: session?.userId ?? null, has: () => false };
  }
  const { auth } = await import("@clerk/nextjs/server");
  const authentication = await auth();
  await setSentryUser(authentication.userId);
  return {
    userId: authentication.userId,
    has: ({ feature }) => authentication.has({ feature }),
  };
}

/**
 * Resolves the caller once per server request.
 *
 * Route guards, the RSC tRPC caller, and API handlers each ask for the caller
 * independently, so an uncached resolver repeats the same local session lookup
 * two or three times in a row before a page can start loading its data. React's
 * request cache collapses those into one; outside a request scope `cache` calls
 * straight through, so background and worker callers are unaffected.
 */
export const applicationAuth = cache(resolveApplicationAuth);

/** Protects a route in SaaS mode; local routes use the local session adapter. */
export async function protectApplicationRoute() {
  assertDeploymentConfigured();
  if (isLocalDeployment()) {
    const local = await applicationAuth();
    if (!local.userId) {
      redirect("/local/setup");
    }
    return;
  }
  const { auth } = await import("@clerk/nextjs/server");
  await auth.protect();
}
