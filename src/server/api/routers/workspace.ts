import { and, eq, gte } from "drizzle-orm";
import {
  aiPreferences,
  localAiConfigurations,
  providerConnections,
  signOffs,
  users,
} from "@/drizzle/schema";
import { isLocalDeployment } from "~/server/deployment";
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
    const [connection, aiPreference, localAiConfiguration, todaySignOff, user] =
      await Promise.all([
        ctx.db.query.providerConnections.findFirst({
          columns: { id: true },
          where: eq(providerConnections.workspaceId, workspace.id),
        }),
        ctx.db.query.aiPreferences.findFirst({
          columns: { id: true },
          where: eq(aiPreferences.workspaceId, workspace.id),
        }),
        ctx.db.query.localAiConfigurations.findFirst({
          columns: { id: true },
          where: eq(localAiConfigurations.workspaceId, workspace.id),
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
      ]);

    return {
      hasProviderConnection: Boolean(connection),
      hasAiConfiguration: isLocalDeployment()
        ? Boolean(localAiConfiguration)
        : Boolean(aiPreference),
      reviewedToday: Boolean(todaySignOff),
      currentStreak: user?.currentStreak ?? 0,
      localMode: isLocalDeployment(),
    };
  }),
});
