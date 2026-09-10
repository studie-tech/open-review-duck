// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReviewSyncStatusButton,
  reviewSyncStatus,
  reviewSyncStatusLabel,
  shouldAutoSyncReviewRevision,
} from "./review-sync-status";

afterEach(cleanup);

describe("review sync status", () => {
  it("ranks in-flight work above a ready revision", () => {
    expect(
      reviewSyncStatus({
        loadingChanges: true,
        probeFailed: true,
        syncing: true,
        updateAvailable: true,
      }),
    ).toBe("loading");
    expect(
      reviewSyncStatus({
        loadingChanges: false,
        probeFailed: false,
        syncing: true,
        updateAvailable: true,
      }),
    ).toBe("syncing");
    expect(
      reviewSyncStatus({
        loadingChanges: false,
        probeFailed: true,
        syncing: false,
        updateAvailable: true,
      }),
    ).toBe("ready");
    expect(
      reviewSyncStatus({
        loadingChanges: false,
        probeFailed: true,
        syncing: false,
        updateAvailable: false,
      }),
    ).toBe("error");
    expect(
      reviewSyncStatus({
        loadingChanges: false,
        probeFailed: false,
        syncing: false,
        updateAvailable: false,
      }),
    ).toBe("idle");
  });

  it("queues one background sync per remote head", () => {
    expect(
      shouldAutoSyncReviewRevision({
        busy: false,
        current: true,
        remoteHeadSha: "next",
      }),
    ).toBe(false);
    expect(
      shouldAutoSyncReviewRevision({
        busy: true,
        current: false,
        remoteHeadSha: "next",
      }),
    ).toBe(false);
    expect(
      shouldAutoSyncReviewRevision({
        attemptedHeadSha: "next",
        busy: false,
        current: false,
        remoteHeadSha: "next",
      }),
    ).toBe(false);
    expect(
      shouldAutoSyncReviewRevision({
        attemptedHeadSha: "old",
        busy: false,
        current: false,
        remoteHeadSha: "next",
      }),
    ).toBe(true);
  });

  it("renders an icon-only control that reports ready and busy states", async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <ReviewSyncStatusButton
        onClick={onClick}
        provider="github"
        status="idle"
      />,
    );

    expect(
      screen.getByRole("button", { name: reviewSyncStatusLabel("idle") }),
    ).toBeEnabled();

    rerender(
      <ReviewSyncStatusButton
        onClick={onClick}
        provider="github"
        status="ready"
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: reviewSyncStatusLabel("ready") }),
    );
    expect(onClick).toHaveBeenCalledOnce();

    rerender(
      <ReviewSyncStatusButton
        onClick={onClick}
        provider="github"
        status="syncing"
      />,
    );
    expect(
      screen.getByRole("button", { name: reviewSyncStatusLabel("syncing") }),
    ).toBeDisabled();
  });
});
