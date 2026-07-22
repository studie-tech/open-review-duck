import "server-only";

import { auth } from "@clerk/nextjs/server";
import { LOCAL_USER_ID } from "~/lib/deployment";
import {
  assertAuthenticationConfigured,
  isLocalDeployment,
} from "~/server/deployment";

export interface ApplicationAuth {
  userId: string | null;
  has(input: { feature: string }): boolean;
}

/** Resolves either Clerk authorization or the isolated local identity. */
export async function applicationAuth(): Promise<ApplicationAuth> {
  if (isLocalDeployment()) {
    return { userId: LOCAL_USER_ID, has: () => false };
  }
  assertAuthenticationConfigured();
  const authentication = await auth();
  return {
    userId: authentication.userId,
    has: ({ feature }) => authentication.has({ feature }),
  };
}

/** Protects a route in authenticated mode and no-ops in local mode. */
export async function protectApplicationRoute() {
  if (isLocalDeployment()) return;
  assertAuthenticationConfigured();
  await auth.protect();
}
