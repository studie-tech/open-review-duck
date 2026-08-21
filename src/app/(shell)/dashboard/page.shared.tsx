import { DashboardOverview } from "~/components/dashboard/dashboard-overview";
import { protectApplicationRoute } from "~/server/auth";
import { api } from "~/trpc/server";

/** Renders the cross-workspace dashboard overview. */
export default async function DashboardPage() {
  await protectApplicationRoute();
  const [pullRequests, monitors] = await Promise.all([
    api.review.dashboard(),
    api.repoReviews.list(),
  ]);
  return (
    <DashboardOverview
      initialPullRequests={pullRequests}
      initialMonitors={monitors}
    />
  );
}
