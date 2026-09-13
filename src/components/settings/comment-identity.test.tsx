// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentIdentity } from "./comment-identity";

const { disconnectOnSuccess, saveMutate, identityData } = vi.hoisted(() => ({
  disconnectOnSuccess: {
    current: undefined as
      | ((result: { remoteRevokeComplete: boolean }) => void | Promise<void>)
      | undefined,
  },
  saveMutate: vi.fn(),
  identityData: {
    publishAsSelf: false,
    connections: [
      {
        connectionId: "connection-1",
        provider: "github" as const,
        displayName: "Acme GitHub",
        credentialKind: "github_app",
        identity: null,
      },
    ],
  },
}));

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast,
}));

vi.mock("~/lib/hosted-provider-authorization", () => ({
  startHostedProviderAuthorization: vi.fn(),
}));

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      provider: { commentIdentity: { invalidate: vi.fn() } },
    }),
    provider: {
      commentIdentity: {
        useQuery: () => ({ data: identityData }),
      },
      saveCommentIdentity: {
        useMutation: () => ({ isPending: false, mutate: saveMutate }),
      },
      disconnectPersonalCredential: {
        useMutation: (options: {
          onSuccess?: (result: { remoteRevokeComplete: boolean }) => void;
        }) => {
          disconnectOnSuccess.current = options.onSuccess;
          return { isPending: false, mutate: vi.fn() };
        },
      },
      connectPersonalCredential: {
        useMutation: () => ({
          isPending: false,
          mutate: vi.fn(),
          error: null,
          reset: vi.fn(),
        }),
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  saveMutate.mockReset();
  toast.error.mockReset();
  toast.success.mockReset();
  toast.warning.mockReset();
  identityData.publishAsSelf = false;
  identityData.connections.splice(1);
  const firstConnection = identityData.connections[0];
  if (firstConnection) firstConnection.identity = null;
});

describe("CommentIdentity", () => {
  it("saves the publish-as-myself preference", async () => {
    render(<CommentIdentity localMode connectionId="connection-1" />);

    await userEvent.click(screen.getByRole("button", { name: "Change" }));
    await userEvent.click(screen.getByRole("radio", { name: /^My account/ }));

    expect(saveMutate).toHaveBeenCalledWith({ publishAsSelf: true });
  });

  it("keeps setup hidden until needed and scopes it to the selected connection", async () => {
    const firstConnection = identityData.connections[0];
    if (!firstConnection) throw new Error("Missing test connection");
    identityData.connections.push({
      ...firstConnection,
      connectionId: "connection-2",
      displayName: "Other GitHub",
    });
    const { rerender } = render(
      <CommentIdentity localMode connectionId="connection-1" />,
    );
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText("Other GitHub")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(
      screen.queryByRole("button", { name: "Connect my account" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Your preference applies to all connections/),
    ).toBeVisible();
    identityData.publishAsSelf = true;
    rerender(<CommentIdentity localMode connectionId="connection-1" />);
    expect(screen.getByText(/Posting here is paused/)).toBeVisible();
    expect(screen.getByText(/1 other connection also needs/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Connect my account" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("Acme GitHub");
    expect(screen.getByLabelText(/Personal access token/)).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("warns when disconnect cannot confirm remote revocation", async () => {
    render(<CommentIdentity localMode connectionId="connection-1" />);

    await disconnectOnSuccess.current?.({ remoteRevokeComplete: false });

    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringMatching(/could not confirm revocation/),
    );
  });
});
