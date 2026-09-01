// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHostedProviderAuthorization } from "~/lib/hosted-provider-authorization";
import type { Connection } from "./provider-common";
import { ProviderSettings } from "./provider-settings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("~/lib/hosted-provider-authorization", () => ({
  startHostedProviderAuthorization: vi.fn(),
}));

vi.mock("~/components/page-container", () => ({
  PageContainer: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}));

vi.mock("~/components/settings/provider-rail", () => ({
  ProviderRail: () => <nav>Connections</nav>,
}));

vi.mock("~/components/settings/connection-detail", () => ({
  ConnectionDetail: ({
    authorizationPending,
    onReauthorize,
  }: {
    authorizationPending: boolean;
    onReauthorize: () => void;
  }) => (
    <button
      type="button"
      disabled={authorizationPending}
      data-pending={authorizationPending}
      onClick={onReauthorize}
    >
      Reconnect
    </button>
  ),
}));

vi.mock("~/components/settings/repository-detail", () => ({
  RepositoryDetail: () => null,
}));

vi.mock("~/components/settings/provider-connection-form", () => ({
  ConnectionFormDialog: () => null,
}));

vi.mock("~/components/ui/confirmation-dialog", () => ({
  ConfirmationDialog: () => null,
}));

vi.mock("~/trpc/react", () => ({
  api: (() => {
    const invalidate = vi.fn();
    /** Creates the inert mutation shape used outside this focused flow. */
    const mutation = () => ({ isPending: false, mutate: vi.fn() });
    return {
      useUtils: () => ({
        provider: {
          listConnections: { invalidate },
          listImportedRepositories: { invalidate },
          listAvailableRepositories: { invalidate },
          listUnimportedPullRequests: { invalidate },
          listOpenPullRequests: { invalidate },
        },
        workspace: { guidance: { invalidate } },
      }),
      provider: {
        previewRepositoryIntake: {
          useQuery: () => ({
            data: undefined,
            error: undefined,
            isError: false,
            isLoading: false,
          }),
        },
        disconnect: { useMutation: mutation },
        deleteRepositoryData: { useMutation: mutation },
        reconcileRepositoryIntake: { useMutation: mutation },
        updateRepositoryIntake: { useMutation: mutation },
      },
    };
  })(),
}));

const connection = {
  id: "connection-1",
  provider: "github",
  credentialKind: "github_app",
  credentialStatus: "active",
  displayName: "Acme GitHub",
  baseUrl: null,
} as Connection;

afterEach(() => {
  cleanup();
  vi.mocked(startHostedProviderAuthorization).mockReset();
  vi.mocked(toast.error).mockReset();
});

describe("ProviderSettings hosted authorization", () => {
  it("starts the managed redirect flow and keeps the connection action pending", async () => {
    vi.mocked(startHostedProviderAuthorization).mockReturnValue(
      new Promise(() => undefined),
    );
    render(
      <ProviderSettings
        initialConnections={[connection]}
        initialRepositories={[]}
        localMode={false}
      />,
    );

    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    await userEvent.click(reconnect);

    expect(startHostedProviderAuthorization).toHaveBeenCalledWith(
      "github",
      "/settings/providers",
    );
    expect(reconnect).toBeDisabled();
    expect(reconnect).toHaveAttribute("data-pending", "true");
  });

  it("restores the action and shows the helper error after a failed start", async () => {
    vi.mocked(startHostedProviderAuthorization).mockRejectedValue(
      new Error("GitHub authorization unavailable"),
    );
    render(
      <ProviderSettings
        initialConnections={[connection]}
        initialRepositories={[]}
        localMode={false}
      />,
    );

    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    await userEvent.click(reconnect);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "GitHub authorization unavailable",
      );
      expect(reconnect).toBeEnabled();
      expect(reconnect).toHaveAttribute("data-pending", "false");
    });
  });
});
