import { SaasAiSettings } from "~/components/settings/ai-settings.saas";
import { protectApplicationRoute } from "~/server/auth";
import { api } from "~/trpc/server";

/** Loads service-owned SaaS model preferences without BYOK controls. */
export default async function SaasAiSettingsPage() {
  await protectApplicationRoute();
  return <SaasAiSettings initialConfiguration={await api.ai.configuration()} />;
}
