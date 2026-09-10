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
        usesOAuth: false,
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
  const firstConnection = identityData.connections[0];
  if (firstConnection) firstConnection.identity = null;
});

describe("CommentIdentity", () => {
  it("saves the publish-as-myself preference", async () => {
    render(<CommentIdentity localMode />);

    await userEvent.click(
      screen.getByRole("checkbox", { name: "Post comments as myself" }),
    );

    expect(saveMutate).toHaveBeenCalledWith({ publishAsSelf: true });
  });

  it("offers a personal token when the reviewer is not connected", () => {
    render(<CommentIdentity localMode />);

    expect(
      screen.getByRole("button", { name: "Connect with a token" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Not connected — posts still appear as ReviewDuck/),
    ).toBeInTheDocument();
  });

  it("warns when disconnect cannot confirm remote revocation", async () => {
    render(<CommentIdentity localMode />);

    await disconnectOnSuccess.current?.({ remoteRevokeComplete: false });

    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringMatching(/could not confirm revocation/),
    );
  });
});
