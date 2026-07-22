import { randomUUID } from "node:crypto";
import { clerkMiddleware } from "@clerk/nextjs/server";
import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from "next/server";
import { localContentSecurityPolicy } from "~/lib/content-security-policy";
import { hostnameFromHostHeader, isLoopbackHostname } from "~/lib/deployment";

const authenticatedMiddleware =
  process.env.DEPLOYMENT_MODE === "local"
    ? undefined
    : clerkMiddleware({
        contentSecurityPolicy: {
          strict: true,
          directives: {
            "base-uri": ["'self'"],
            "frame-ancestors": ["'none'"],
            "object-src": ["'none'"],
          },
        },
      });

/** Applies Clerk in authenticated mode and confines local mode to loopback. */
export function proxy(request: NextRequest, event: NextFetchEvent) {
  if (process.env.DEPLOYMENT_MODE !== "local") {
    if (!authenticatedMiddleware) {
      throw new Error("Authentication middleware was not initialized");
    }
    return authenticatedMiddleware(request, event);
  }
  const requestHostname = hostnameFromHostHeader(request.headers.get("host"));
  if (!isLoopbackHostname(requestHostname)) {
    return new NextResponse("Local mode is available only through localhost.", {
      status: 403,
    });
  }
  const nonce = Buffer.from(randomUUID()).toString("base64");
  const policy = localContentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
  );
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
