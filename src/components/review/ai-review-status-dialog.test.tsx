// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiReviewStatusDialog,
  aiReviewStatusLabel,
} from "./ai-review-status-dialog";

const state = vi.hoisted(() => ({
  status: {
    data: { id: "run-1", status: "running" },
    isLoading: false,
    isError: false,
  },
  run: {
    jobId: "run-1",
    status: "running",
    terminalState: null as string | null,
    createdAt: new Date(),
    completedAt: null,
    error: null,
    coverage: { total: 3, completed: 1, reused: 0, waived: 0, failed: 0 },
    findings: [
      {
        id: "finding-1",
        title: "A saved finding",
        body: "Evidence from the review",
        severity: "high",
        state: "anchored",
      },
    ],
  },
  mutate: vi.fn(),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({}),
    ai: {
      reviewStatus: { useQuery: () => state.status },
      reviewHistory: {
        useQuery: () => ({
          data: [
            {
              id: "run-1",
              status: state.run.status,
              createdAt: state.run.createdAt,
            },
          ],
          isLoading: false,
        }),
      },
      reviewRun: { useQuery: () => ({ data: state.run }) },
      start: {
        useMutation: () => ({ mutate: state.mutate, isPending: false }),
      },
    },
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.status.isLoading = false;
  state.status.isError = false;
  state.status.data.status = "running";
  state.run.status = "running";
  state.run.terminalState = null;
});

describe("persisted AI review dialog", () => {
  it("shows active progress and prevents another start while letting the user close", async () => {
    const onClose = vi.fn();
    render(<AiReviewStatusDialog pullRequestId="pr-1" onClose={onClose} />);
    expect(
      screen.getByRole("progressbar", { name: "Review plan progress" }),
    ).toHaveAttribute("value", "1");
    expect(
      screen.getByRole("button", { name: "Review in progress" }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("restores completed findings on remount without starting a review", async () => {
    state.status.data.status = "completed";
    state.run.status = "completed";
    state.run.terminalState = "complete";
    const first = render(
      <AiReviewStatusDialog pullRequestId="pr-1" onClose={() => {}} />,
    );
    first.unmount();
    render(<AiReviewStatusDialog pullRequestId="pr-1" onClose={() => {}} />);
    expect(screen.getByText("A saved finding")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Start another review…" }),
    );
    expect(
      screen.getByRole("heading", {
        name: "Review this pull request with AI?",
      }),
    ).toBeVisible();
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("does not offer to start before status loads or after a status error", () => {
    state.status.isLoading = true;
    const view = render(
      <AiReviewStatusDialog pullRequestId="pr-1" onClose={() => {}} />,
    );
    expect(screen.getByText("Loading review status…")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Review in progress" }),
    ).toBeDisabled();
    state.status.isLoading = false;
    state.status.isError = true;
    view.rerender(
      <AiReviewStatusDialog pullRequestId="pr-1" onClose={() => {}} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load review status",
    );
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it.each([
    ["queued", null, "AI review queued"],
    ["waiting_for_provider", null, "AI reviewing…"],
    ["streaming", null, "AI reviewing…"],
    ["failed", null, "AI review failed"],
    ["cancelled", null, "AI review cancelled"],
    ["completed", "partial", "AI review partial"],
    ["completed", "skipped", "AI review skipped"],
  ])("labels %s / %s honestly", (status, terminal, label) => {
    expect(
      aiReviewStatusLabel({
        status: status ?? "",
        deepReviewTerminalState: terminal,
      }),
    ).toBe(label);
  });
});
