import type { NextRequest } from "next/server";
import { env } from "~/env";

/** Runs the SaaS-only UploadThing callback and direct-upload protocol. */
async function uploadThingRequest(request: NextRequest) {
  const [{ createRouteHandler }, { semanticFileRouter }] = await Promise.all([
    import("uploadthing/next"),
    import("~/server/semantic/uploadthing-router"),
  ]);
  const handlers = createRouteHandler({
    router: semanticFileRouter,
    config: { token: env.UPLOADTHING_TOKEN },
  });
  return request.method === "GET"
    ? handlers.GET(request)
    : handlers.POST(request);
}

export const GET = uploadThingRequest;
export const POST = uploadThingRequest;
