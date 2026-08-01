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
  const guidance = await api.workspace.guidance();
  return (
    <AppShell
      initialGuidance={guidance}
      deploymentMode={isLocalDeployment() ? "local" : "saas"}
    >
      {children}
    </AppShell>
  );
}
