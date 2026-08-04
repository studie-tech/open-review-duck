import { describe, expect, it } from "vitest";
import { expiredSnapshotIds } from "./retention";

const now = new Date("2026-07-22T12:00:00.000Z");
/** Returns a stable test timestamp before the fixed clock. */
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

describe("expiredSnapshotIds", () => {
  it("enforces age and count limits together", () => {
    const snapshots = [
      { id: "old", createdAt: daysAgo(40) },
      { id: "third", createdAt: daysAgo(3) },
      { id: "second", createdAt: daysAgo(2) },
      { id: "latest", createdAt: daysAgo(1) },
    ];

    expect(
      expiredSnapshotIds(snapshots, {
        retentionDays: 30,
        retentionSnapshots: 2,
        retainedSnapshotId: "latest",
        now,
      }),
    ).toEqual(["old", "third"]);
  });

  it("preserves the active snapshot even outside a newly tightened policy", () => {
    expect(
      expiredSnapshotIds(
        [
          { id: "previous", createdAt: daysAgo(10) },
          { id: "active", createdAt: daysAgo(9) },
        ],
        {
          retentionDays: 1,
          retentionSnapshots: 1,
          retainedSnapshotId: "active",
          now,
        },
      ),
    ).toEqual(["previous"]);
  });
});
