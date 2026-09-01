import {
  createCallerFactory,
  createTRPCRouter,
  publicProcedure,
} from "~/server/api/trpc";
import { aiRouter } from "./routers/ai";
import { providerRouter } from "./routers/provider";
import { repoReviewsRouter } from "./routers/repo-reviews";
import { reviewRouter } from "./routers/review";
import { workspaceRouter } from "./routers/workspace";

/** Primary tRPC router: health, ai, provider, repoReviews, review, and workspace. */
export const appRouter = createTRPCRouter({
  health: publicProcedure.query(() => ({ status: "ok" as const })),
  ai: aiRouter,
  provider: providerRouter,
  repoReviews: repoReviewsRouter,
  review: reviewRouter,
  workspace: workspaceRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/** Server-side caller for the tRPC API. */
export const createCaller = createCallerFactory(appRouter);
