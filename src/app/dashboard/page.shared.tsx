import { DashboardContent } from "~/components/dashboard/dashboard-content";
import { protectApplicationRoute } from "~/server/auth";
import { isLocalDeployment } from "~/server/deployment";
import { api } from "~/trpc/server";

/** Renders the dashboard page interface. */
export default async function DashboardPage() {
  await protectApplicationRoute();
  const local = isLocalDeployment();
  const [pullRequests, aiConfiguration, aiPlanUsage] = await Promise.all([
    api.review.dashboard(),
    api.ai.configuration(),
    local ? Promise.resolve(null) : api.ai.planUsage(),
  ]);
  return (
    <DashboardContent
      initialPullRequests={pullRequests}
      initialAiConfiguration={aiConfiguration}
      initialAiPlanUsage={aiPlanUsage}
      localMode={local}
    />
  );
}
