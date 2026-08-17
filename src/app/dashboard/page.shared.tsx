import { DashboardContent } from "~/components/dashboard/dashboard-content";
import { protectApplicationRoute } from "~/server/auth";
import { api } from "~/trpc/server";

/** Renders the dashboard page interface. */
export default async function DashboardPage() {
  await protectApplicationRoute();
  return (
    <DashboardContent initialPullRequests={await api.review.dashboard()} />
  );
}
