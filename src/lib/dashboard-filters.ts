import type { PriorityInboxItem } from "~/lib/priority-inbox";

export const DASHBOARD_FILTERS_STORAGE_KEY = "reviewduck:dashboard-filters";

export type DashboardProviderFilter = "all" | PriorityInboxItem["provider"];

export interface DashboardFilters {
  provider: DashboardProviderFilter;
  repository: string;
  search: string;
}

const providers = new Set<DashboardProviderFilter>([
  "all",
  "github",
  "gitlab",
  "azure_devops",
]);

export const defaultDashboardFilters: DashboardFilters = {
  provider: "all",
  repository: "all",
  search: "",
};

/** Returns whether a stored provider value is one the inbox can apply. */
function isProviderFilter(value: unknown): value is DashboardProviderFilter {
  return (
    typeof value === "string" && providers.has(value as DashboardProviderFilter)
  );
}

/** Reads the last dashboard search and list filters the reviewer applied. */
export function dashboardFilters(storage: Pick<Storage, "getItem">) {
  try {
    const stored = storage.getItem(DASHBOARD_FILTERS_STORAGE_KEY);
    if (!stored) return defaultDashboardFilters;
    const parsed = JSON.parse(stored) as Partial<DashboardFilters>;
    return {
      provider: isProviderFilter(parsed.provider) ? parsed.provider : "all",
      repository:
        typeof parsed.repository === "string" && parsed.repository.length > 0
          ? parsed.repository
          : "all",
      search: typeof parsed.search === "string" ? parsed.search : "",
    } satisfies DashboardFilters;
  } catch {
    return defaultDashboardFilters;
  }
}

/** Remembers the dashboard search and list filters for the next visit. */
export function rememberDashboardFilters(
  storage: Pick<Storage, "setItem">,
  filters: DashboardFilters,
) {
  try {
    storage.setItem(DASHBOARD_FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Browser privacy settings can make local storage unavailable.
  }
}
