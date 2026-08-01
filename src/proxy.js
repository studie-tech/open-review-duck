import { deploymentProxy } from "reviewduck-deployment-proxy";

/**
 * Runs the request boundary selected for the deployment target.
 *
 * @param {import("next/server").NextRequest} request
 * @param {import("next/server").NextFetchEvent} event
 */
export function proxy(request, event) {
  return deploymentProxy(request, event);
}

export const config = {
  matcher: [
    "/((?!\\.well-known/workflow|_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
