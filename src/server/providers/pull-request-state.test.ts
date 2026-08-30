import { describe, expect, it, vi } from "vitest";

import type { repositories } from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import type { ConnectionAccess } from "./credentials";
import { refreshRepositoryPullRequestStates } from "./pull-request-state";

type Database = typeof database;

/** Builds a database whose throttle claim rejects the pass. */
function createThrottledDb() {
  const update = {
    set: () => update,
    where: () => update,
    returning: async () => [],
  };
  return { update: () => update } as unknown as Database;
}

/** Builds connection access that fails if the pass reaches the provider. */
function createUnusedAccess() {
  const connection = vi.fn(async () => {
    throw new Error("connection read");
  });
  const access = {
    connection,
    provider: async () => {
      throw new Error("provider resolved");
    },
  } as unknown as ConnectionAccess;
  return { access, connection };
}

describe("repository pull-request state refresh", () => {
  it("skips the connection read when the throttle claim fails", async () => {
    const { access, connection } = createUnusedAccess();

    const result = await refreshRepositoryPullRequestStates(
      createThrottledDb(),
      {
        id: "repository-1",
        workspaceId: "workspace-1",
        connectionId: "connection-1",
      } as typeof repositories.$inferSelect,
      access,
    );

    expect(result).toEqual({ checked: false, changed: 0, queued: 0 });
    expect(connection).not.toHaveBeenCalled();
  });
});
