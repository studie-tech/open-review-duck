import { AppShell } from "~/components/app-shell";
import { protectApplicationRoute } from "~/server/auth";
import { isLocalDeployment } from "~/server/deployment";
import { api } from "~/trpc/server";

/** Renders the dashboard layout interface. */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await protectApplicationRoute();
  const local = isLocalDeployment();
  const [guidance, initialAiConfiguration, initialAiPlanUsage] =
    await Promise.all([
      api.workspace.guidance(),
      local ? api.ai.configuration() : Promise.resolve(undefined),
      local ? Promise.resolve(null) : api.ai.planUsage(),
    ]);
  return (
    <AppShell
      initialGuidance={guidance}
      initialAiConfiguration={initialAiConfiguration}
      initialAiPlanUsage={initialAiPlanUsage}
      deploymentMode={local ? "local" : "saas"}
    >
      {children}
    </AppShell>
  );
}
