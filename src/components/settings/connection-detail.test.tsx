// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionDetail } from "./connection-detail";
import type { Connection } from "./provider-common";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("~/trpc/react", () => ({
  api: {
    provider: {
      listAvailableRepositories: {
        useQuery: vi.fn(() => ({
          data: [],
          isLoading: false,
          isFetching: false,
          isError: false,
        })),
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

/** Shared handlers so each case only varies the pending flag. */
function renderDetail(authorizationPending: boolean) {
  return render(
    <ConnectionDetail
      authorizationPending={authorizationPending}
      canReauthorize
      canReplaceToken={false}
      connection={connection}
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
