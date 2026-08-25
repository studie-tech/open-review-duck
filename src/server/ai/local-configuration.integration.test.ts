import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localAiConfigurations, users, workspaces } from "@/drizzle/schema";
import { createCaller } from "~/server/api/root";
import { db } from "~/server/db";
import { readLocalAiSecret } from "./local-configuration";

const userId = `ai-configuration-${randomUUID()}`;
const caller = createCaller({
  auth: { userId, has: () => false },
  db,
  headers: new Headers(),
});

const baseInput = {
  provider: "openrouter",
  model: "example/model",
  apiKey: "initial-key",
  clearApiKey: false,
  clearHeaders: false,
  headers: { "x-reviewduck": "enabled" },
  baseUrl: "https://1.1.1.1/v1",
  useManagedModels: false,
  mode: "on_demand" as const,
  reviewPullRequests: false,
};

beforeAll(async () => {
  await db.insert(users).values({ id: userId });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

describe("local AI configuration persistence", () => {
  it("preserves, replaces, clears, and isolates stored credentials", async () => {
    await caller.ai.saveConfiguration(baseInput);
    /** Reads the fixture workspace's encrypted AI configuration. */
    const workspaceConfiguration = async () => {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.ownerId, userId),
      });
      if (!workspace) throw new Error("Local workspace was not stored");
      const row = await db.query.localAiConfigurations.findFirst({
        where: eq(localAiConfigurations.workspaceId, workspace.id),
      });
      if (!row) throw new Error("Local AI configuration was not stored");
      return { row, secret: await readLocalAiSecret(row.workspaceId, row) };
    };

    await caller.ai.saveConfiguration({
      ...baseInput,
      apiKey: undefined,
      headers: {},
    });
    expect((await workspaceConfiguration()).secret).toMatchObject({
      apiKey: "initial-key",
      headers: { "x-reviewduck": "enabled" },
    });

    await caller.ai.saveConfiguration({
      ...baseInput,
      apiKey: "replacement-key",
      clearHeaders: true,
      headers: {},
    });
    expect((await workspaceConfiguration()).secret).toMatchObject({
      apiKey: "replacement-key",
      headers: {},
    });

    await caller.ai.saveConfiguration({
      ...baseInput,
      provider: "custom",
      apiKey: undefined,
      headers: {},
    });
    const switched = await db.query.localAiConfigurations.findFirst({
      where: eq(
        localAiConfigurations.workspaceId,
        (
          await db.query.workspaces.findFirst({
            where: eq(workspaces.ownerId, userId),
          })
        )?.id ?? "00000000-0000-4000-8000-000000000000",
      ),
    });
    expect(switched).toBeDefined();
    const switchedSecret =
      switched && (await readLocalAiSecret(switched.workspaceId, switched));
    expect(switchedSecret?.apiKey).toBeUndefined();
    expect(switchedSecret?.headers).toEqual({});
  });

  it("returns setup state for an unreadable encrypted configuration", async () => {
    const current = await db.query.localAiConfigurations.findFirst({
      where: eq(
        localAiConfigurations.workspaceId,
        (
          await db.query.workspaces.findFirst({
            where: eq(workspaces.ownerId, userId),
          })
        )?.id ?? "00000000-0000-4000-8000-000000000000",
      ),
    });
    if (!current) throw new Error("Local AI configuration was not stored");
    await db
      .update(localAiConfigurations)
      .set({ encryptedConfiguration: "damaged" })
      .where(eq(localAiConfigurations.id, current.id));
    await expect(caller.ai.configuration()).resolves.toMatchObject({
      configuration: null,
    });
  });
});
