import { describe, expect, it, vi } from "vitest";

import type { db as database } from "~/server/db";
import { refreshRepositoryPullRequestStates } from "./pull-request-state";

type Database = typeof database;

/** Builds a database whose throttle claim rejects the pass. */
function createThrottledDb() {
  const findConnection = vi.fn(async () => undefined);
  const update = {
    set: () => update,
    where: () => update,
    returning: async () => [],
  };
  const db = {
    query: {
      repositories: {
        findFirst: async () => ({
          id: "repository-1",
          workspaceId: "workspace-1",
          connectionId: "connection-1",
        }),
      },
      providerConnections: { findFirst: findConnection },
    },
    update: () => update,
  } as unknown as Database;
  return { db, findConnection };
}

describe("repository pull-request state refresh", () => {
  it("skips the connection read when the throttle claim fails", async () => {
    const { db, findConnection } = createThrottledDb();

    const result = await refreshRepositoryPullRequestStates(db, {
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
    });

    expect(result).toEqual({ checked: false, changed: 0, queued: 0 });
    expect(findConnection).not.toHaveBeenCalled();
  });
});
