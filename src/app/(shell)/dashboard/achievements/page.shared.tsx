import { AchievementsContent } from "~/components/dashboard/achievements-content";
import { protectApplicationRoute } from "~/server/auth";
import { api } from "~/trpc/server";

/** Renders the achievements page interface. */
export default async function AchievementsPage() {
  await protectApplicationRoute();
  const stats = await api.review.gamification();
  return <AchievementsContent initialStats={stats} fetchedAt={Date.now()} />;
}
