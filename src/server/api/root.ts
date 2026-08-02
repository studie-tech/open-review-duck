import {
  createCallerFactory,
  createTRPCRouter,
  publicProcedure,
} from "~/server/api/trpc";
import { aiRouter } from "./routers/ai";
import { providerRouter } from "./routers/provider";
import { reviewRouter } from "./routers/review";
import { workspaceRouter } from "./routers/workspace";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  health: publicProcedure.query(() => ({ status: "ok" as const })),
  ai: aiRouter,
  provider: providerRouter,
  review: reviewRouter,
  workspace: workspaceRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.post.all();
 *       ^? Post[]
 */
export const createCaller = createCallerFactory(appRouter);
