import { randomUUID } from "node:crypto";
import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from "next/server";
import { localContentSecurityPolicy } from "~/lib/content-security-policy";
import { hostnameFromHostHeader, isLoopbackHostname } from "~/lib/deployment";

/** Confines the local appliance to loopback and applies its response policy. */
export function deploymentProxy(request: NextRequest, _event: NextFetchEvent) {
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
