import { and, eq, gte } from "drizzle-orm";
import {
  aiConfigurations,
  providerConnections,
  signOffs,
  users,
} from "@/drizzle/schema";
import { ensurePersonalWorkspace } from "~/server/workspaces/service";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const workspaceRouter = createTRPCRouter({
  current: protectedProcedure.query(({ ctx }) =>
    ensurePersonalWorkspace(ctx.db, ctx.auth.userId),
  ),

  guidance: protectedProcedure.query(async ({ ctx }) => {
    const workspace = await ensurePersonalWorkspace(ctx.db, ctx.auth.userId);
    const now = new Date();
    const todayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const [connection, aiConfiguration, todaySignOff, user] = await Promise.all(
      [
        ctx.db.query.providerConnections.findFirst({
          columns: { id: true },
          where: eq(providerConnections.workspaceId, workspace.id),
        }),
        ctx.db.query.aiConfigurations.findFirst({
          columns: { id: true },
          where: eq(aiConfigurations.workspaceId, workspace.id),
        }),
        ctx.db.query.signOffs.findFirst({
          columns: { id: true },
          where: and(
            eq(signOffs.userId, ctx.auth.userId),
            gte(signOffs.signedOffAt, todayUtc),
          ),
        }),
        ctx.db.query.users.findFirst({
          columns: { currentStreak: true },
          where: eq(users.id, ctx.auth.userId),
        }),
      ],
    );

    return {
      hasProviderConnection: Boolean(connection),
      hasAiConfiguration: Boolean(aiConfiguration),
      reviewedToday: Boolean(todaySignOff),
      currentStreak: user?.currentStreak ?? 0,
    };
  }),
});
