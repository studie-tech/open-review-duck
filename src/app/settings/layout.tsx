import { AppShell } from "~/components/app-shell";
import { protectApplicationRoute } from "~/server/auth";
import { isLocalDeployment } from "~/server/deployment";
import { api } from "~/trpc/server";

/** Renders the settings layout interface. */
export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await protectApplicationRoute();
  const guidance = await api.workspace.guidance();
  return (
    <AppShell
      initialGuidance={guidance}
      deploymentMode={isLocalDeployment() ? "local" : "authenticated"}
    >
      {children}
    </AppShell>
  );
}
