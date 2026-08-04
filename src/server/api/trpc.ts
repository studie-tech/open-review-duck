import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { applicationAuth } from "~/server/auth";
import { db } from "~/server/db";
import { publicTrpcErrorMessage } from "./error";

/** Creates the authenticated request context shared by HTTP and server callers. */
export const createTRPCContext = async (opts: { headers: Headers }) => {
  const authentication = await applicationAuth();
  return {
    db,
    auth: authentication,
    ...opts,
  };
};

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      message: publicTrpcErrorMessage(error.code, shape.message),
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

/** Creates type-safe server-side callers for the application router. */
export const createCallerFactory = t.createCallerFactory;

/** Creates application routers and domain subrouters. */
export const createTRPCRouter = t.router;

/** Defines procedures that do not require an authenticated user. */
export const publicProcedure = t.procedure;

/** Defines procedures that require and preserve a non-null user identity. */
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.auth.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      auth: {
        ...ctx.auth,
        userId: ctx.auth.userId,
      },
    },
  });
});
