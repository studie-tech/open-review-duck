"use client";

import { getToken } from "@clerk/nextjs";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchStreamLink, retryLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { useState } from "react";
import SuperJSON from "superjson";

import type { AppRouter } from "~/server/api/root";
import {
  createAuthenticatedTransport,
  refreshAuthenticationForRetry,
} from "./authenticated-fetch";
import { createQueryClient } from "./query-client";

let clientQueryClientSingleton: QueryClient | undefined;
/** Returns the request-local or browser-wide Query Client instance. */
const getQueryClient = () => {
  if (typeof window === "undefined") {
    // Server: always make a new query client
    return createQueryClient();
  }
  // Browser: use singleton pattern to keep the same query client
  clientQueryClientSingleton ??= createQueryClient();

  return clientQueryClientSingleton;
};

export const api = createTRPCReact<AppRouter>();

/**
 * Inference helper for inputs.
 *
 * @example type HelloInput = RouterInputs['example']['hello']
 */
export type RouterInputs = inferRouterInputs<AppRouter>;

/**
 * Inference helper for outputs.
 *
 * @example type HelloOutput = RouterOutputs['example']['hello']
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

/** Provides the shared tRPC and TanStack Query clients to the React tree. */
export function TRPCReactProvider(props: {
  children: React.ReactNode;
  localMode?: boolean;
}) {
  const queryClient = getQueryClient();

  const [trpcClient] = useState(() => {
    const authentication = props.localMode
      ? undefined
      : createAuthenticatedTransport(getToken);
    return api.createClient({
      links: [
        ...(authentication
          ? [
              retryLink({
                retry: ({ attempts, error }) =>
                  refreshAuthenticationForRetry(
                    attempts,
                    error,
                    authentication.refreshSession,
                  ),
              }),
            ]
          : []),
        httpBatchStreamLink({
          fetch: authentication?.fetch ?? globalThis.fetch.bind(globalThis),
          transformer: SuperJSON,
          url: `${getBaseUrl()}/api/trpc`,
          headers: () => {
            const headers = new Headers();
            headers.set("x-trpc-source", "nextjs-react");
            return headers;
          },
        }),
      ],
    });
  });

  return (
    <QueryClientProvider client={queryClient}>
      <api.Provider client={trpcClient} queryClient={queryClient}>
        {props.children}
      </api.Provider>
    </QueryClientProvider>
  );
}

/** Returns the absolute application URL used by the tRPC client. */
function getBaseUrl() {
  if (typeof window !== "undefined") return window.location.origin;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
