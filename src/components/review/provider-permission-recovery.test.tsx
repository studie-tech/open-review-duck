// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHostedProviderAuthorization } from "~/lib/hosted-provider-authorization";
import { ProviderPermissionRecovery } from "./provider-permission-recovery";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("~/lib/hosted-provider-authorization", () => ({
  startHostedProviderAuthorization: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(startHostedProviderAuthorization).mockReset();
  vi.mocked(toast.error).mockReset();
});

const connection = {
  connectionId: "connection-1",
  credentialKind: "oauth",
  canReplaceToken: false,
  canReconnect: true,
};

describe("ProviderPermissionRecovery", () => {
  it("starts the redirect flow and stays pending while navigation begins", async () => {
    vi.mocked(startHostedProviderAuthorization).mockReturnValue(
      new Promise(() => undefined),
    );
    render(
      <ProviderPermissionRecovery
        kind="review"
        provider="gitlab"
        connection={connection}
        pullRequestUrl="https://gitlab.example/pull/7"
        reviewPath="/review/pull-request-7"
      />,
    );

    const reconnect = screen.getByRole("button", {
      name: "Open provider settings",
    });
    await userEvent.click(reconnect);

    expect(startHostedProviderAuthorization).toHaveBeenCalledWith(
      "gitlab",
      "/review/pull-request-7",
    );
    expect(reconnect).toBeDisabled();
  });

  it("restores the action and shows the helper error when authorization fails", async () => {
    vi.mocked(startHostedProviderAuthorization).mockRejectedValue(
      new Error("Authorization expired"),
    );
    render(
      <ProviderPermissionRecovery
        kind="sync"
        provider="gitlab"
        connection={connection}
        pullRequestUrl="https://gitlab.example/pull/7"
      />,
    );

    const reconnect = screen.getByRole("button", {
      name: "Open provider settings",
    });
    await userEvent.click(reconnect);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Authorization expired");
      expect(reconnect).toBeEnabled();
    });
  });
});
