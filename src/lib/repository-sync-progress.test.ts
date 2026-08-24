import { describe, expect, it } from "vitest";
import {
  REPOSITORY_SYNC_PROGRESS,
  repositorySyncActivity,
} from "./repository-sync-progress";

describe("repository sync progress", () => {
  it("describes each durable phase with user-facing activity", () => {
    expect(repositorySyncActivity(0)).toBe("Waiting to start");
    expect(repositorySyncActivity(REPOSITORY_SYNC_PROGRESS.fetching)).toBe(
      "Resolving branch",
    );
    expect(repositorySyncActivity(REPOSITORY_SYNC_PROGRESS.listing)).toBe(
      "Loading repository tree",
    );
    expect(repositorySyncActivity(REPOSITORY_SYNC_PROGRESS.downloading)).toBe(
      "Fetching source files",
    );
    expect(repositorySyncActivity(REPOSITORY_SYNC_PROGRESS.analyzing)).toBe(
      "Analyzing repository structure",
    );
    expect(repositorySyncActivity(REPOSITORY_SYNC_PROGRESS.storing)).toBe(
      "Storing source snapshot",
    );
    expect(repositorySyncActivity(REPOSITORY_SYNC_PROGRESS.saving)).toBe(
      "Saving review units",
    );
    expect(repositorySyncActivity(REPOSITORY_SYNC_PROGRESS.completed)).toBe(
      "Repository ready",
    );
  });
});
