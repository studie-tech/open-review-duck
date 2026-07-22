import { AiSettings } from "~/components/settings/ai-settings";
import { isLocalDeployment } from "~/server/deployment";
import { api } from "~/trpc/server";

/** Loads the user's configuration and renders the AI settings page. */
export default async function AiSettingsPage() {
  const configuration = await api.ai.configuration();
  return (
    <AiSettings
      initialConfiguration={configuration}
      allowManagedModels={!isLocalDeployment()}
    />
  );
}
