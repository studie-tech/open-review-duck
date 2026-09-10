// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentIdentity } from "./comment-identity";

const { saveMutate, identityData } = vi.hoisted(() => ({
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

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
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
        useMutation: () => ({ isPending: false, mutate: vi.fn() }),
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
  identityData.publishAsSelf = false;
  identityData.connections[0]!.identity = null;
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
});
