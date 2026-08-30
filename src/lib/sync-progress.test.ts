import { describe, expect, it } from "vitest";
import {
  followActiveReviewJobs,
  SYNC_PROGRESS,
  syncProgressLabel,
} from "./sync-progress";

describe("syncProgressLabel", () => {
  it("maps durable progress checkpoints to user-facing phases", () => {
    expect(syncProgressLabel("queued", SYNC_PROGRESS.queued)).toBe(
      "Waiting to start",
    );
    expect(syncProgressLabel("running", SYNC_PROGRESS.fetching)).toBe(
      "Fetching pull request and changed files",
    );
    expect(syncProgressLabel("running", SYNC_PROGRESS.analyzing)).toBe(
      "Analyzing the dependency path",
    );
    expect(syncProgressLabel("running", SYNC_PROGRESS.storingSources)).toBe(
      "Saving private source files",
    );
    expect(syncProgressLabel("running", SYNC_PROGRESS.savingSnapshot)).toBe(
      "Saving the review snapshot",
    );
    expect(syncProgressLabel("running", SYNC_PROGRESS.addingToQueue)).toBe(
      "Adding the review to your queue",
    );
  });
});

describe("followActiveReviewJobs", () => {
  it("polls only while a durable job is still in flight", () => {
    expect(followActiveReviewJobs({ state: { data: [] } })).toBe(false);
    expect(
      followActiveReviewJobs({
        state: { data: [{ id: "sync-1" }] },
      }),
    ).toBe(1_500);
  });
});
