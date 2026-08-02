import {
  defaultShouldDehydrateQuery,
  QueryClient,
} from "@tanstack/react-query";
import SuperJSON from "superjson";

const nonRetryableCodes = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_SUPPORTED",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "UNPROCESSABLE_CONTENT",
  "TOO_MANY_REQUESTS",
]);

/** Retries transient query failures without repeating expected client rejections. */
export function shouldRetryQuery(failureCount: number, error: unknown) {
  if (failureCount >= 3) return false;
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return true;
  }
  const data = error.data;
  return !(
    typeof data === "object" &&
    data !== null &&
    "code" in data &&
    typeof data.code === "string" &&
    nonRetryableCodes.has(data.code)
  );
}

/** Creates a Query Client with ReviewDuck's shared cache defaults. */
export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        // Preserve freshly hydrated server data through the initial client render.
        staleTime: 30 * 1000,
        retry: shouldRetryQuery,
      },
      dehydrate: {
        serializeData: SuperJSON.serialize,
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) ||
          query.state.status === "pending",
      },
      hydrate: {
        deserializeData: SuperJSON.deserialize,
      },
    },
  });
