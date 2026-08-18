// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection, ImportedRepository } from "./provider-common";
import { ProviderRail } from "./provider-rail";

const connections = [
  {
    id: "conn-github",
    provider: "github",
    displayName: "studie-tech",
    baseUrl: null,
    credentialKind: "github_app",
    credentialStatus: "active",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  },
  {
    id: "conn-gitlab",
    provider: "gitlab",
    displayName: "Work GitLab",
    baseUrl: null,
    credentialKind: "oauth",
    credentialStatus: "revoked",
    createdAt: new Date("2026-01-02T00:00:00Z"),
  },
] as Connection[];

const repositories = [
  {
    id: "repo-duck",
    externalId: "1",
    owner: "studie-tech",
    name: "open-review-duck",
    provider: "github",
    connectionName: "studie-tech",
    credentialKind: "github_app",
    connectionId: "conn-github",
    webUrl: "https://github.com/studie-tech/open-review-duck",
    reviewIntakeMode: "all",
    intakeLastAttemptAt: null,
    intakeLastReconciledAt: null,
    intakeLastError: null,
  },
  {
    id: "repo-api",
    externalId: "2",
    owner: "platform",
    name: "duck-api",
    provider: "gitlab",
    connectionName: "Work GitLab",
    credentialKind: "oauth",
    connectionId: "conn-gitlab",
    webUrl: "https://gitlab.com/platform/duck-api",
    reviewIntakeMode: "manual",
    intakeLastAttemptAt: null,
    intakeLastReconciledAt: null,
    intakeLastError: "Rate limited",
  },
] as ImportedRepository[];

afterEach(cleanup);

describe("ProviderRail", () => {
  it("lists connections with nested repositories and reports selection", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ProviderRail
        connections={connections}
        repositories={repositories}
        selection={{ kind: "connection", id: "conn-github" }}
        search=""
        onSearchChange={vi.fn()}
        onSelect={onSelect}
        onAddConnection={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /GitHub · GitHub App/ }),
    ).toHaveAttribute("aria-current", "true");
    expect(screen.getByText(/Reconnect/)).toBeVisible();
    expect(screen.getByText("All PRs")).toBeVisible();
    expect(screen.getByLabelText("Intake needs attention")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open-review-duck/ }));
    expect(onSelect).toHaveBeenCalledWith({
      kind: "repository",
      id: "repo-duck",
    });
  });

  it("filters both levels by search and keeps parent connections visible", () => {
    render(
      <ProviderRail
        connections={connections}
        repositories={repositories}
        selection={undefined}
        search="duck-api"
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
        onAddConnection={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Work GitLab/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /duck-api/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /studie-tech/ }),
    ).not.toBeInTheDocument();
  });

  it("shows an empty message when nothing matches the search", () => {
    render(
      <ProviderRail
        connections={connections}
        repositories={repositories}
        selection={undefined}
        search="zzz"
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
        onAddConnection={vi.fn()}
      />,
    );

    expect(screen.getByText(/Nothing matches/)).toBeVisible();
  });
});
