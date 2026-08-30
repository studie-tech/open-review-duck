import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { db as database } from "~/server/db";
import { requirePersonalWorkspaceAdministrator } from "./access";
import { ensurePersonalWorkspace } from "./service";

const mocks = vi.hoisted(() => ({
  isLocalDeployment: vi.fn(() => true),
}));

vi.mock("~/server/deployment", () => ({
  isLocalDeployment: mocks.isLocalDeployment,
}));
vi.mock("@clerk/nextjs/server", () => ({ clerkClient: vi.fn() }));

type Database = typeof database;

interface FakeMembership {
  role: string;
  isAdmin: boolean;
}

/** Serves one stored membership and records every promotion write. */
function createFakeDb({ role, isAdmin }: FakeMembership) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    query: {
      workspaceMembers: {
        findFirst: async () => ({
          role,
          user: { isAdmin },
          workspace: { id: "workspace-1" },
        }),
      },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
          return [];
        },
      }),
    }),
  };
  return { db: db as unknown as Database, updates };
}

beforeEach(() => {
  mocks.isLocalDeployment.mockReturnValue(true);
});

describe("ensurePersonalWorkspace", () => {
  it("promotes a local owner who is not an admin yet", async () => {
    const { db, updates } = createFakeDb({ role: "owner", isAdmin: false });
    await expect(ensurePersonalWorkspace(db, "reviewer-1")).resolves.toEqual({
      id: "workspace-1",
    });
    expect(updates).toEqual([{ isAdmin: true }]);
  });

  it("writes nothing when the local owner is already an admin", async () => {
    const { db, updates } = createFakeDb({ role: "owner", isAdmin: true });
    await ensurePersonalWorkspace(db, "reviewer-1");
    expect(updates).toEqual([]);
  });

  it("leaves hosted owners alone", async () => {
    mocks.isLocalDeployment.mockReturnValue(false);
    const { db, updates } = createFakeDb({ role: "owner", isAdmin: false });
    await ensurePersonalWorkspace(db, "reviewer-1");
    expect(updates).toEqual([]);
  });
});

describe("requirePersonalWorkspaceAdministrator", () => {
  it("returns the workspace to an owner without a second lookup", async () => {
    const { db } = createFakeDb({ role: "owner", isAdmin: true });
    await expect(
      requirePersonalWorkspaceAdministrator(db, "reviewer-1"),
    ).resolves.toEqual({ id: "workspace-1" });
  });

  it("rejects a plain member", async () => {
    const { db } = createFakeDb({ role: "member", isAdmin: false });
    await expect(
      requirePersonalWorkspaceAdministrator(db, "reviewer-1"),
    ).rejects.toThrow(TRPCError);
  });
});
