import { describe, expect, it } from "vitest";
import { shouldActivateQueueItem } from "./queue-policy";

describe("shouldActivateQueueItem", () => {
  it("does not re-add the same automatically discovered revision", () => {
    expect(
      shouldActivateQueueItem({
        existingState: "removed",
        removedHeadSha: "head-1",
        incomingHeadSha: "head-1",
        explicit: false,
      }),
    ).toBe(false);
  });

  it("allows a new revision or explicit restore to return", () => {
    expect(
      shouldActivateQueueItem({
        existingState: "removed",
        removedHeadSha: "head-1",
        incomingHeadSha: "head-2",
        explicit: false,
      }),
    ).toBe(true);
    expect(
      shouldActivateQueueItem({
        existingState: "removed",
        removedHeadSha: "head-1",
        incomingHeadSha: "head-1",
        explicit: true,
      }),
    ).toBe(true);
  });
});
