import { describe, expect, it } from "vitest";
import type { RouterOutputs } from "~/trpc/react";
import { workspaceSourcePlan } from "./use-private-workspace-source-hydration";

type Workspace = RouterOutputs["review"]["workspace"];
type Unit = Workspace["units"][number];

/** Creates a minimal review unit for source-plan tests. */
function unit(id: string, path: string, status: Unit["status"] = "pending") {
  return { id, path, status, revisionState: "initial" } as Unit;
}

/** Creates a minimal changed-file manifest entry. */
function file(path: string) {
  return {
    id: path,
    path,
    previousPath: null,
    changeType: "modified",
    additions: 1,
    deletions: 0,
    isBinary: false,
    skipReason: null,
  } as Workspace["files"][number];
}

describe("workspaceSourcePlan", () => {
  it("follows actionable tree order and only warms rendered neighbors in Files mode", () => {
    const units = [
      unit("a", "src/a.ts"),
      unit("b", "src/b.ts", "signed_off"),
      unit("c", "src/c.ts"),
      unit("d", "src/d.ts"),
      unit("e", "src/e.ts"),
    ];
    const data = {
      concepts: [],
      files: ["src/e.ts", "src/c.ts", "src/a.ts", "src/d.ts", "src/b.ts"].map(
        file,
      ),
    };

    expect(workspaceSourcePlan(data, units, "a", "files")).toEqual({
      activePath: "src/a.ts",
      nextPaths: ["src/c.ts"],
      previewPaths: ["src/b.ts"],
    });
  });

  it("warms remaining concept files before the next global unit in Guided mode", () => {
    const units = [
      unit("active", "src/current.ts"),
      unit("same-file", "src/current.ts"),
      unit("concept-next", "src/concept.ts"),
      unit("waiting", "src/waiting.ts", "waiting"),
      unit("global-next", "src/global.ts"),
    ];
    const data = {
      files: units.map(({ path }) => file(path)),
      concepts: [
        {
          id: "concept",
          memberIds: ["active", "same-file", "concept-next"],
        },
        { id: "global-concept", memberIds: ["global-next"] },
      ],
    } as Pick<Workspace, "concepts" | "files">;

    expect(workspaceSourcePlan(data, units, "active", "path")).toEqual({
      activePath: "src/current.ts",
      nextPaths: ["src/concept.ts"],
      previewPaths: ["src/global.ts"],
    });
  });

  it("warms every actionable file in the next Guided concept", () => {
    const units = [
      unit("active", "src/current.ts"),
      unit("next-a", "src/next-a.ts"),
      unit("next-b", "src/next-b.ts"),
      unit("done", "src/done.ts", "signed_off"),
    ];
    const data = {
      files: units.map(({ path }) => file(path)),
      concepts: [
        { id: "current", memberIds: ["active"] },
        {
          id: "next",
          memberIds: ["next-a", "next-b", "done"],
        },
      ],
    } as Pick<Workspace, "concepts" | "files">;

    expect(workspaceSourcePlan(data, units, "active", "path")).toEqual({
      activePath: "src/current.ts",
      nextPaths: [],
      previewPaths: ["src/next-a.ts", "src/next-b.ts"],
    });
  });

  it("changes plans without changing the active file identity", () => {
    const units = [unit("one", "src/one.ts"), unit("two", "src/two.ts")];
    const data = {
      files: units.map(({ path }) => file(path)),
      concepts: [{ id: "concept", memberIds: ["one", "two"] }],
    } as Pick<Workspace, "concepts" | "files">;

    const files = workspaceSourcePlan(data, units, "one", "files");
    const guided = workspaceSourcePlan(data, units, "one", "path");

    expect(files.activePath).toBe("src/one.ts");
    expect(guided.activePath).toBe("src/one.ts");
    expect(files.nextPaths).toEqual(["src/two.ts"]);
    expect(guided.nextPaths).toEqual(["src/two.ts"]);
  });
});
