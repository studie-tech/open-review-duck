import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  providerConnections,
  repositories,
  users,
  workspaces,
} from "@/drizzle/schema";
import type { db as database } from "~/server/db";
import { db } from "~/server/db";

const mocks = vi.hoisted(() => ({
  refreshRepositoryPullRequestStates: vi.fn(),
}));

vi.mock("./pull-request-state", () => ({
  refreshRepositoryPullRequestStates: mocks.refreshRepositoryPullRequestStates,
}));

import { reconcileWorkspaceIntake } from "./intake";

type Database = typeof database;

const fixture = {
  userId: `intake-scheduling-${randomUUID()}`,
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  repositoryIdPrefix: randomUUID().slice(0, 24),
};

/** Returns a stable UUID whose lexical order matches the supplied index. */
function repositoryId(index: number) {
  return `${fixture.repositoryIdPrefix}${index.toString().padStart(12, "0")}`;
}

/** Inserts manual repositories without invoking provider credentials during a pass. */
async function insertRepositories(
  count: number,
  options?: { checkedAt?: Date | null; firstIndex?: number },
) {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const firstIndex = options?.firstIndex ?? 0;
  await db.insert(repositories).values(
    Array.from({ length: count }, (_value, offset) => {
      const index = firstIndex + offset;
      return {
        id: repositoryId(index),
        workspaceId: fixture.workspaceId,
        connectionId: fixture.connectionId,
        externalId: `repository-${index}`,
        owner: "reviewduck",
        name: `intake-${index}`,
        defaultBranch: "main",
        webUrl: `https://github.com/reviewduck/intake-${index}`,
        reviewIntakeMode: "manual" as const,
        pullRequestStateLastCheckedAt: options?.checkedAt,
        createdAt,
      };
    }),
  );
}

beforeAll(async () => {
  await db.insert(users).values({ id: fixture.userId });
  await db.insert(workspaces).values({
    id: fixture.workspaceId,
    ownerId: fixture.userId,
    name: "Intake scheduling workspace",
    slug: `intake-scheduling-${randomUUID()}`,
  });
  await db.insert(providerConnections).values({
    id: fixture.connectionId,
    workspaceId: fixture.workspaceId,
    provider: "github",
    externalAccountId: `intake-scheduling-${randomUUID()}`,
    displayName: "Intake scheduling connection",
  });
});

beforeEach(() => {
  mocks.refreshRepositoryPullRequestStates.mockReset();
});

afterEach(async () => {
  await db
    .delete(repositories)
    .where(eq(repositories.workspaceId, fixture.workspaceId));
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, fixture.userId));
});

describe("workspace intake scheduling", () => {
  it("progresses beyond the first page across repeated passes", async () => {
    await insertRepositories(15);
    const claimedIds: string[] = [];
    mocks.refreshRepositoryPullRequestStates.mockImplementation(
      async (database: Database, repository: { id: string }) => {
        const [claimed] = await database
          .update(repositories)
          .set({
            pullRequestStateLastCheckedAt: new Date(
              Date.parse("2026-02-01T00:00:00.000Z") + claimedIds.length,
            ),
          })
          .where(
            and(
              eq(repositories.id, repository.id),
              isNull(repositories.pullRequestStateLastCheckedAt),
            ),
          )
          .returning({ id: repositories.id });
        if (claimed) claimedIds.push(claimed.id);
        return { checked: Boolean(claimed), changed: 0, queued: 0 };
      },
    );

    await reconcileWorkspaceIntake(db, fixture.workspaceId);
    await reconcileWorkspaceIntake(db, fixture.workspaceId);

    expect(new Set(claimedIds)).toEqual(
      new Set(
        Array.from({ length: 15 }, (_value, index) => repositoryId(index)),
      ),
    );
  });

  it("uses stable tie-breakers and prioritizes new membership", async () => {
    const checkedAt = new Date("2026-02-01T00:00:00.000Z");
    await insertRepositories(12, { checkedAt });
    mocks.refreshRepositoryPullRequestStates.mockResolvedValue({
      checked: false,
      changed: 0,
      queued: 0,
    });

    await reconcileWorkspaceIntake(db, fixture.workspaceId);

    expect(
      mocks.refreshRepositoryPullRequestStates.mock.calls.map(
        ([, repository]) => repository.id,
      ),
    ).toEqual(
      Array.from({ length: 10 }, (_value, index) => repositoryId(index)),
    );

    await db.delete(repositories).where(eq(repositories.id, repositoryId(0)));
    await insertRepositories(1, { firstIndex: 20 });
    mocks.refreshRepositoryPullRequestStates.mockClear();

    await reconcileWorkspaceIntake(db, fixture.workspaceId);

    const selected = mocks.refreshRepositoryPullRequestStates.mock.calls.map(
      ([, repository]) => repository.id,
    );
    expect(selected[0]).toBe(repositoryId(20));
    expect(selected).not.toContain(repositoryId(0));
  });

  it("does not duplicate claimed provider work across overlapping passes", async () => {
    await insertRepositories(15);
    const providerWork: string[] = [];
    mocks.refreshRepositoryPullRequestStates.mockImplementation(
      async (database: Database, repository: { id: string }) => {
        const [claimed] = await database
          .update(repositories)
          .set({ pullRequestStateLastCheckedAt: new Date() })
          .where(
            and(
              eq(repositories.id, repository.id),
              isNull(repositories.pullRequestStateLastCheckedAt),
            ),
          )
          .returning({ id: repositories.id });
        if (claimed) providerWork.push(claimed.id);
        return { checked: Boolean(claimed), changed: 0, queued: 0 };
      },
    );

    await Promise.all([
      reconcileWorkspaceIntake(db, fixture.workspaceId),
      reconcileWorkspaceIntake(db, fixture.workspaceId),
    ]);

    expect(providerWork.length).toBeGreaterThanOrEqual(10);
    expect(new Set(providerWork).size).toBe(providerWork.length);
  });
});
