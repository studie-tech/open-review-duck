import { describe, expect, it } from "vitest";
import {
  DASHBOARD_FILTERS_STORAGE_KEY,
  dashboardFilters,
  defaultDashboardFilters,
  rememberDashboardFilters,
} from "./dashboard-filters";

/** Builds an in-memory Storage stand-in for one test. */
function memoryStorage(initial?: Record<string, string>) {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("dashboardFilters", () => {
  it("returns defaults when nothing has been stored", () => {
    expect(dashboardFilters(memoryStorage())).toEqual(defaultDashboardFilters);
  });

  it("restores a valid stored filter set", () => {
    expect(
      dashboardFilters(
        memoryStorage({
          [DASHBOARD_FILTERS_STORAGE_KEY]: JSON.stringify({
            provider: "gitlab",
            repositories: ["gitlab:payments/api", "github:acme/web"],
            search: "sonia",
            showDrafts: false,
          }),
        }),
      ),
    ).toEqual({
      provider: "gitlab",
      repositories: ["gitlab:payments/api", "github:acme/web"],
      search: "sonia",
      showDrafts: false,
    });
  });

  it("migrates the older single-repository filter string", () => {
    expect(
      dashboardFilters(
        memoryStorage({
          [DASHBOARD_FILTERS_STORAGE_KEY]: JSON.stringify({
            provider: "gitlab",
            repository: "gitlab:payments/api",
            search: "",
            showDrafts: true,
          }),
        }),
      ).repositories,
    ).toEqual(["gitlab:payments/api"]);
  });

  it("keeps drafts visible when older stored filters omit the toggle", () => {
    expect(
      dashboardFilters(
        memoryStorage({
          [DASHBOARD_FILTERS_STORAGE_KEY]: JSON.stringify({
            provider: "github",
            repositories: [],
            search: "",
          }),
        }),
      ).showDrafts,
    ).toBe(true);
  });

  it("falls back when stored JSON is invalid or unknown", () => {
    expect(
      dashboardFilters(
        memoryStorage({ [DASHBOARD_FILTERS_STORAGE_KEY]: "{not-json" }),
      ),
    ).toEqual(defaultDashboardFilters);
    expect(
      dashboardFilters(
        memoryStorage({
          [DASHBOARD_FILTERS_STORAGE_KEY]: JSON.stringify({
            provider: "bitbucket",
            repository: 12,
            search: null,
          }),
        }),
      ),
    ).toEqual(defaultDashboardFilters);
  });
});

describe("rememberDashboardFilters", () => {
  it("writes the current filters for the next visit", () => {
    const storage = memoryStorage();
    rememberDashboardFilters(storage, {
      provider: "github",
      repositories: ["github:acme/web", "gitlab:payments/api"],
      search: "inventory",
      showDrafts: false,
    });
    expect(dashboardFilters(storage)).toEqual({
      provider: "github",
      repositories: ["github:acme/web", "gitlab:payments/api"],
      search: "inventory",
      showDrafts: false,
    });
  });
});
