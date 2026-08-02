declare module "reviewduck-deployment-proxy" {
  import type { NextFetchEvent, NextRequest } from "next/server";

  export function deploymentProxy(
    request: NextRequest,
    event: NextFetchEvent,
  ): Response | Promise<Response>;
}
