// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "~/trpc/react";
import { ConnectionDetail } from "./connection-detail";
import type { Connection } from "./provider-common";

vi.mock("./comment-identity", () => ({ CommentIdentity: () => null }));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("~/trpc/react", () => ({
  api: {
    provider: {
      githubInstallationSettings: {
        useQuery: vi.fn(),
      },
      listAvailableRepositories: {
        useQuery: vi.fn(),
      },
      importRepository: {
        useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
      },
    },
  },
}));

const connection = {
  id: "connection-1",
  provider: "github",
  credentialKind: "github_app",
  credentialStatus: "active",
  displayName: "Acme GitHub",
  baseUrl: null,
} as Connection;

/** Renders one connection with inert handlers outside the behavior under test. */
function renderDetail(
  authorizationPending = false,
  selectedConnection = connection,
) {
  return render(
    <ConnectionDetail
      authorizationPending={authorizationPending}
      canReauthorize
      canReplaceToken={false}
      connection={selectedConnection}
      importedRepositories={[]}
      localMode={false}
      onAddConnection={vi.fn()}
      onDisconnect={vi.fn()}
      onImported={vi.fn()}
      onReauthorize={vi.fn()}
      onReplaceToken={vi.fn()}
      onSelectRepository={vi.fn()}
    />,
  );
}

afterEach(cleanup);

const refetchRepositories = vi.fn();
const refetchSettings = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.provider.githubInstallationSettings.useQuery).mockReturnValue({
    data: {
      url: "https://github.com/organizations/acme/settings/installations/42",
    },
    isFetching: false,
    isError: false,
    refetch: refetchSettings,
  } as never);
  vi.mocked(api.provider.listAvailableRepositories.useQuery).mockReturnValue({
    data: [],
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: refetchRepositories,
  } as never);
});

describe("ConnectionDetail reconnect", () => {
  it("disables reconnect and shows a spinner while authorization is pending", () => {
    renderDetail(true);
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    expect(reconnect).toBeDisabled();
    expect(reconnect.querySelector(".animate-spin")).toBeTruthy();
  });

  it("enables reconnect when authorization is idle", () => {
    renderDetail(false);
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    expect(reconnect).toBeEnabled();
    expect(reconnect.querySelector(".animate-spin")).toBeNull();
  });
});

describe("ConnectionDetail GitHub access", () => {
  it.each([
    "https://github.com/organizations/acme/settings/installations/42",
    "https://github.com/settings/installations/42",
  ])("opens this installation's settings in a new tab: %s", (url) => {
    vi.mocked(api.provider.githubInstallationSettings.useQuery).mockReturnValue(
      {
        data: { url },
      } as never,
    );
    renderDetail();
    expect(
      screen.getByRole("link", { name: /Manage GitHub access/ }),
    ).toHaveAttribute("href", url);
    expect(
      screen.getByRole("link", { name: /Manage GitHub access/ }),
    ).toHaveAttribute("target", "_blank");
    expect(
      api.provider.githubInstallationSettings.useQuery,
    ).toHaveBeenCalledWith(
      { connectionId: connection.id },
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByText("Missing a repository?")).toBeVisible();
    expect(
      screen.getByText(/Save your changes, then return here/),
    ).toBeVisible();
  });

  it("refreshes repository access on return from GitHub and on demand", async () => {
    renderDetail();
    expect(
      api.provider.listAvailableRepositories.useQuery,
    ).toHaveBeenCalledWith(
      { connectionId: connection.id },
      expect.objectContaining({ refetchOnWindowFocus: "always" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh repositories" }),
    );
    expect(refetchRepositories).toHaveBeenCalledOnce();
  });

  it("disables refresh while the repository request is running", () => {
    vi.mocked(api.provider.listAvailableRepositories.useQuery).mockReturnValue({
      isLoading: true,
      isFetching: true,
    } as never);
    renderDetail();
    expect(
      screen.getByRole("button", { name: "Refresh repositories" }),
    ).toBeDisabled();
  });

  it("offers a retry when GitHub settings cannot be loaded", async () => {
    vi.mocked(api.provider.githubInstallationSettings.useQuery).mockReturnValue(
      {
        isError: true,
        isFetching: false,
        refetch: refetchSettings,
      } as never,
    );
    renderDetail();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load GitHub access settings",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Retry GitHub access settings" }),
    );
    expect(refetchSettings).toHaveBeenCalledOnce();
  });

  it("keeps the access action pending until its destination is available", () => {
    vi.mocked(api.provider.githubInstallationSettings.useQuery).mockReturnValue(
      {
        isFetching: true,
      } as never,
    );
    renderDetail();
    expect(
      screen.getByRole("button", { name: "Manage GitHub access" }),
    ).toBeDisabled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it.each([
    { provider: "github", credentialKind: "pat" },
    { provider: "github", credentialKind: "local_pat" },
    { provider: "gitlab", credentialKind: "oauth" },
    { provider: "azure_devops", credentialKind: "pat" },
  ] as const)(
    "does not offer GitHub App settings for $provider/$credentialKind",
    (overrides) => {
      renderDetail(false, { ...connection, ...overrides });
      expect(
        screen.queryByText("Missing a repository?"),
      ).not.toBeInTheDocument();
      expect(
        api.provider.githubInstallationSettings.useQuery,
      ).toHaveBeenCalledWith(
        { connectionId: connection.id },
        expect.objectContaining({ enabled: false }),
      );
      expect(
        api.provider.listAvailableRepositories.useQuery,
      ).toHaveBeenCalledWith(
        { connectionId: connection.id },
        expect.objectContaining({ refetchOnWindowFocus: false }),
      );
    },
  );
});
