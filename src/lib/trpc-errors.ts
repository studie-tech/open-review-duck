import { TRPCError } from "@trpc/server";

/** Reports whether a direct server caller failed because its resource is absent. */
export function isTrpcNotFoundError(cause: unknown) {
  return cause instanceof TRPCError && cause.code === "NOT_FOUND";
}
