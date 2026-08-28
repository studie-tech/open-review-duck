// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardOverview } from "./dashboard-overview";

vi.mock("~/trpc/react", () => ({
  api: {
    review: {
      dashboard: {
        useQuery: vi.fn((_input, options) => ({ data: options.initialData })),
      },
    },
    repoReviews: {
      list: {
        useQuery: vi.fn((_input, options) => ({ data: options.initialData })),
      },
    },
  },
}));

afterEach(cleanup);

describe("DashboardOverview", () => {
  it("guides attention into the next pull request and repository review", () => {
    const pullRequests: ComponentProps<
      typeof DashboardOverview
    >["initialPullRequests"] = [
      {
        id: "pull-request-1",
        number: 42,
        title: "Make review modes easier to find",
        authorLogin: "mira",
        authorAvatarUrl: null,
        state: "open",
        webUrl: "https://example.com/pull/42",
        updatedAt: new Date("2026-08-21T12:00:00Z"),
        additions: 24,
        deletions: 3,
        repositoryOwner: "acme",
        repositoryName: "web",
        provider: "github",
        queueState: "active",
        queueSource: "manual",
        removedAt: null,
        totalUnits: 5,
        signedUnits: 2,
        carriedSignOffs: 0,
      },
    ];
    const monitors: ComponentProps<
      typeof DashboardOverview
    >["initialMonitors"] = [
      {
        id: "monitor-1",
        branch: "main",
        currentHeadSha: "1234567890abcdef",
        lastCheckedAt: new Date("2026-08-21T12:10:00Z"),
        lastSyncedAt: new Date("2026-08-21T12:10:00Z"),
        lastError: null,
        createdAt: new Date("2026-08-20T12:00:00Z"),
        pullRequestId: "repository-review-1",
        repositoryId: "repository-1",
        repositoryOwner: "acme",
        repositoryName: "platform",
        repositoryWebUrl: "https://example.com/acme/platform",
        provider: "github",
        snapshot: {
          id: "snapshot-1",
          version: 2,
          headSha: "1234567890abcdef",
          createdAt: new Date("2026-08-21T12:10:00Z"),
        },
        progress: { total: 12, signed: 8, unseen: 4, changed: 2 },
        coverage: { files: 10, reviewableFiles: 8, nonReviewableFiles: 2 },
        activeSync: null,
        latestCodeRun: null,
        latestComplianceRun: null,
      },
    ];

    render(
      <DashboardOverview
        initialPullRequests={pullRequests}
        initialMonitors={monitors}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Choose where to focus." }),
    ).toBeVisible();
    expect(screen.getByText("2 areas need attention")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Next pull request/i }),
    ).toHaveAttribute("href", "/review/pull-request-1");
    expect(
      screen.getByRole("link", { name: /Changed since your review/i }),
    ).toHaveAttribute("href", "/repo-reviews?monitor=monitor-1");
    expect(
      screen.getByRole("link", { name: /Open pull request inbox/i }),
    ).toHaveAttribute("href", "/pullrequests");
    expect(screen.getByText("Latest updates")).toBeVisible();
    expect(screen.getByRole("main")).toHaveClass("w-full");
    expect(screen.getByRole("main").className).not.toMatch(/max-w-/);
  });
});
