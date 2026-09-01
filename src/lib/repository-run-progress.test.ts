import { describe, expect, it } from "vitest";
import {
  followActiveRepositorySyncs,
  hasActiveRepositoryRun,
  mergeRepositoryRunProgress,
} from "./repository-run-progress";

const idle = {
  latestCodeRun: { status: "completed" },
  latestComplianceRun: null,
};

describe("followActiveRepositorySyncs", () => {
  it("polls only while a monitor has an active source sync", () => {
    expect(followActiveRepositorySyncs({ state: { data: [] } })).toBe(false);
    expect(
      followActiveRepositorySyncs({
        state: {
          data: [{ activeSync: null }, { activeSync: { progress: 1 } }],
        },
      }),
    ).toBe(1_500);
    expect(
      followActiveRepositorySyncs({
        state: { data: [{ activeSync: null }] },
      }),
    ).toBe(false);
  });
});

describe("hasActiveRepositoryRun", () => {
  it("follows a repository run through every in-flight status", () => {
    for (const status of [
      "queued",
      "waiting_for_provider",
      "running",
      "streaming",
    ]) {
      expect(
        hasActiveRepositoryRun([idle, { ...idle, latestCodeRun: { status } }]),
      ).toBe(true);
    }
    expect(
      hasActiveRepositoryRun([
        { ...idle, latestComplianceRun: { status: "running" } },
      ]),
    ).toBe(true);
  });

  it("stops following finished and absent runs", () => {
    expect(hasActiveRepositoryRun([])).toBe(false);
    expect(
      hasActiveRepositoryRun([
        idle,
        { latestCodeRun: null, latestComplianceRun: { status: "failed" } },
      ]),
    ).toBe(false);
  });
});

type LiveRun = {
  monitorId: string;
  snapshotId: string | null;
  activeSync: { id: string } | null;
  latestCodeRun: { status: string; progress: number } | null;
  latestComplianceRun: { status: string; progress: number } | null;
};
type CachedMonitor = {
  id: string;
  branch: string;
  snapshot: { id: string } | null;
} & Omit<LiveRun, "monitorId" | "snapshotId">;

const cached: CachedMonitor[] = [
  {
    id: "monitor-1",
    branch: "main",
    snapshot: { id: "snapshot-1" },
    activeSync: null,
    latestCodeRun: { status: "queued", progress: 0 },
    latestComplianceRun: null,
  },
  {
    id: "monitor-2",
    branch: "release",
    snapshot: null,
    activeSync: null,
    latestCodeRun: null,
    latestComplianceRun: null,
  },
];

describe("mergeRepositoryRunProgress", () => {
  it("replaces run state and keeps the rest of each monitor", () => {
    const live: LiveRun[] = [
      {
        monitorId: "monitor-1",
        snapshotId: "snapshot-1",
        activeSync: { id: "sync-1" },
        latestCodeRun: { status: "streaming", progress: 60 },
        latestComplianceRun: null,
      },
    ];

    expect(mergeRepositoryRunProgress(cached, live)).toEqual([
      {
        id: "monitor-1",
        branch: "main",
        snapshot: { id: "snapshot-1" },
        activeSync: { id: "sync-1" },
        latestCodeRun: { status: "streaming", progress: 60 },
        latestComplianceRun: null,
      },
      cached[1],
    ]);
  });

  it("drops runs from a read that resolved against an older snapshot", () => {
    const live: LiveRun[] = [
      {
        monitorId: "monitor-1",
        snapshotId: "snapshot-0",
        activeSync: { id: "sync-1" },
        latestCodeRun: { status: "running", progress: 40 },
        latestComplianceRun: { status: "running", progress: 10 },
      },
    ];

    expect(mergeRepositoryRunProgress(cached, live)[0]).toEqual({
      ...cached[0],
      activeSync: { id: "sync-1" },
    });
  });

  it("takes runs for a monitor that has no snapshot yet", () => {
    const live: LiveRun[] = [
      {
        monitorId: "monitor-2",
        snapshotId: null,
        activeSync: null,
        latestCodeRun: { status: "queued", progress: 0 },
        latestComplianceRun: null,
      },
    ];

    expect(mergeRepositoryRunProgress(cached, live)[1]).toEqual({
      ...cached[1],
      latestCodeRun: { status: "queued", progress: 0 },
    });
  });

  it("leaves monitors the progress read did not cover untouched", () => {
    const live: LiveRun[] = [];
    expect(mergeRepositoryRunProgress(cached, live)).toEqual(cached);
  });
});
