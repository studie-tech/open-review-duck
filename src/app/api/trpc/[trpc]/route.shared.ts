import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { NextRequest } from "next/server";

import { env } from "~/env";
import { internalErrorDetails } from "~/server/api/error";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";

export const maxDuration = 800;

/**
 * This wraps the `createTRPCContext` helper and provides the required context for the tRPC API when
 * handling a HTTP request (e.g. when you make requests from Client Components).
 */
const createContext = async (req: NextRequest) => {
  return createTRPCContext({
    headers: req.headers,
  });
};

/** Handles an incoming tRPC HTTP request. */
const handler = (req: NextRequest) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext(req),
    onError: ({ path, error }) => {
      if (error.code !== "INTERNAL_SERVER_ERROR") return;
      console.error("tRPC request failed", {
        path: path ?? "<no-path>",
        deployment: env.NODE_ENV,
        error: internalErrorDetails(error),
      });
    },
  });

export { handler as GET, handler as POST };
