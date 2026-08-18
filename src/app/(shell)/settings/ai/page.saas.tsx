import { SaasAiSettings } from "~/components/settings/ai-settings.saas";
import { protectApplicationRoute } from "~/server/auth";
import { api } from "~/trpc/server";

/** Loads service-owned SaaS model preferences without BYOK controls. */
export default async function SaasAiSettingsPage() {
  await protectApplicationRoute();
  const [configuration, planUsage] = await Promise.all([
    api.ai.configuration(),
    api.ai.planUsage(),
  ]);
  if (!planUsage) throw new Error("SaaS plan usage is unavailable");
  return (
    <SaasAiSettings
      initialConfiguration={configuration}
      initialPlanUsage={planUsage}
    />
  );
}
