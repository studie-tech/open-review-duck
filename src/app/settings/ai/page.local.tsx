import { LocalAiSettings } from "~/components/settings/ai-settings.local";
import { protectApplicationRoute } from "~/server/auth";
import { api } from "~/trpc/server";

/** Loads local managed-free and encrypted provider configuration. */
export default async function LocalAiSettingsPage() {
  await protectApplicationRoute();
  return (
    <LocalAiSettings initialConfiguration={await api.ai.configuration()} />
  );
}
