import { ProviderSettings } from "~/components/settings/provider-settings";
import { protectApplicationRoute } from "~/server/auth";
import { isLocalDeployment } from "~/server/deployment";
import { api } from "~/trpc/server";

/** Renders the provider settings page interface. */
export default async function ProviderSettingsPage() {
  await protectApplicationRoute();
  const [connections, repositories] = await Promise.all([
    api.provider.listConnections(),
    api.provider.listImportedRepositories(),
  ]);
  return (
    <ProviderSettings
      initialConnections={connections}
      initialRepositories={repositories}
      localMode={isLocalDeployment()}
    />
  );
}
