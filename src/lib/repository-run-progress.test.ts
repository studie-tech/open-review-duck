import { describe, expect, it } from "vitest";
import {
  hasActiveRepositoryRun,
  mergeRepositoryRunProgress,
} from "./repository-run-progress";

const idle = {
  latestCodeRun: { status: "completed" },
  latestComplianceRun: null,
};

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
  activeSync: { id: string } | null;
  latestCodeRun: { status: string; progress: number } | null;
  latestComplianceRun: { status: string; progress: number } | null;
};
type CachedMonitor = { id: string; branch: string } & Omit<
  LiveRun,
  "monitorId"
>;

const cached: CachedMonitor[] = [
  {
    id: "monitor-1",
    branch: "main",
    activeSync: null,
    latestCodeRun: { status: "queued", progress: 0 },
    latestComplianceRun: null,
  },
  {
    id: "monitor-2",
    branch: "release",
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
        activeSync: { id: "sync-1" },
        latestCodeRun: { status: "streaming", progress: 60 },
        latestComplianceRun: null,
      },
    ];

    expect(mergeRepositoryRunProgress(cached, live)).toEqual([
      {
        id: "monitor-1",
        branch: "main",
        activeSync: { id: "sync-1" },
        latestCodeRun: { status: "streaming", progress: 60 },
        latestComplianceRun: null,
      },
      cached[1],
    ]);
  });

  it("leaves monitors the progress read did not cover untouched", () => {
    const live: LiveRun[] = [];
    expect(mergeRepositoryRunProgress(cached, live)).toEqual(cached);
  });
});
