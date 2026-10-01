import { describe, expect, it } from "vitest";
import {
  attributeFileCommits,
  commitEffectLabels,
  commitsForSelection,
  type FileCommitPatch,
  oldestFirstByParent,
  parseUnifiedHunks,
  unifiedPatch,
} from "./line-commit-history";

/** Builds a linear commit whose patch is the only field tests vary. */
function commit(
  sha: string,
  patch: string | null,
  authoredAt: string,
  message = `${sha} subject\n\n${sha} body`,
): FileCommitPatch {
  return {
    sha,
    author: "reviewer",
    authoredAt,
    message,
    patch,
    merge: false,
  };
}

describe("attributeFileCommits", () => {
  it("attributes a replacement and a later deletion to the base lines", () => {
    const history = attributeFileCommits({
      truncated: false,
      commits: [
        commit(
          "aaaaaaaa",
          "@@ -3,1 +3,1 @@\n-c\n+C\n",
          "2026-09-01T00:00:00Z",
          "Re-enable tutorials\n\nWalk through the queue again.",
        ),
        commit(
          "bbbbbbbb",
          "@@ -2,3 +2,0 @@\n-b\n-C\n-d\n",
          "2026-09-02T00:00:00Z",
          "Stop writing tutorial flags\n\nThe service already does this.",
        ),
      ],
    });

    expect(history.unmapped).toBe(false);
    expect(history.commits.map((entry) => entry.shortSha)).toEqual([
      "bbbbbbb",
      "aaaaaaa",
    ]);
    expect(history.commits[0]).toMatchObject({
      subject: "Stop writing tutorial flags",
      body: "The service already does this.",
      baseLines: [2, 3, 4],
      headLines: [],
    });
    expect(history.commits[1]).toMatchObject({
      subject: "Re-enable tutorials",
      baseLines: [3],
      headLines: [],
    });
  });

  it("keeps an added head line on the commit that introduced it", () => {
    const history = attributeFileCommits({
      truncated: false,
      commits: [
        commit(
          "cccccccc",
          "@@ -1,0 +1,2 @@\n+one\n+two\n",
          "2026-09-03T00:00:00Z",
        ),
      ],
    });

    expect(history.commits[0]).toMatchObject({
      baseLines: [],
      headLines: [1, 2],
    });
  });

  it("round-trips a source diff through the unified patch parser", () => {
    const patch = unifiedPatch("alpha\nbeta\n", "alpha\nBETA\n");
    expect(parseUnifiedHunks(patch)).toEqual([
      { oldStart: 2, oldCount: 1, lines: ["-", "+"] },
    ]);
  });

  it("lists every commit without line numbers when a patch is missing", () => {
    const history = attributeFileCommits({
      truncated: false,
      commits: [
        commit("dddddddd", null, "2026-09-04T00:00:00Z", "Opaque change"),
        commit("eeeeeeee", "@@ -1,1 +1,1 @@\n-a\n+b\n", "2026-09-05T00:00:00Z"),
      ],
    });

    expect(history.unmapped).toBe(true);
    expect(history.commits.every((entry) => entry.mapped === false)).toBe(true);
    expect(history.commits).toHaveLength(2);
  });

  it("applies a later hunk after an earlier hunk in the same commit adds lines", () => {
    const history = attributeFileCommits({
      truncated: false,
      commits: [
        commit(
          "ffffffff",
          "@@ -1,1 +1,3 @@\n-a\n+a\n+x\n+y\n@@ -4,1 +6,1 @@\n-d\n+D\n",
          "2026-09-08T00:00:00Z",
        ),
      ],
    });

    expect(history.commits[0]).toMatchObject({
      baseLines: [1, 4],
      headLines: [1, 2, 3, 6],
    });
  });

  it("applies provider order when author dates run backwards", () => {
    const history = attributeFileCommits({
      truncated: false,
      commits: [
        commit("aaaaaaaa", "@@ -1,0 +1,1 @@\n+new\n", "2026-09-09T00:00:00Z"),
        commit("bbbbbbbb", "@@ -2,1 +2,1 @@\n-a\n+A\n", "2026-09-01T00:00:00Z"),
      ],
    });

    expect(
      history.commits.find((entry) => entry.sha === "bbbbbbbb"),
    ).toMatchObject({ baseLines: [1], headLines: [2] });
  });

  it("orders a newest-first parent chain from the oldest root", () => {
    expect(
      oldestFirstByParent([
        { sha: "child", parents: ["root"] },
        { sha: "root", parents: ["outside"] },
      ]).map((commit) => commit.sha),
    ).toEqual(["root", "child"]);
  });

  it("drops merge commits and reports a truncated history as unmapped", () => {
    const history = attributeFileCommits({
      truncated: true,
      commits: [
        {
          ...commit(
            "ffffffff",
            "@@ -1 +1 @@\n-a\n+b\n",
            "2026-09-06T00:00:00Z",
          ),
          merge: true,
        },
        commit("99999999", "@@ -1 +1 @@\n-a\n+b\n", "2026-09-07T00:00:00Z"),
      ],
    });

    expect(history.truncated).toBe(true);
    expect(history.commits.map((entry) => entry.sha)).toEqual(["99999999"]);
    expect(history.commits[0]?.mapped).toBe(false);
  });
});

describe("commitsForSelection", () => {
  it("keeps commits that intersect the selected base lines", () => {
    const history = attributeFileCommits({
      truncated: false,
      commits: [
        commit("aaaaaaaa", "@@ -3,1 +3,1 @@\n-c\n+C\n", "2026-09-01T00:00:00Z"),
        commit(
          "bbbbbbbb",
          "@@ -2,3 +2,0 @@\n-b\n-C\n-d\n",
          "2026-09-02T00:00:00Z",
        ),
      ],
    });
    const selection = {
      baseLines: [2, 3, 4],
      headLines: [],
      removedBaseLines: [2, 3, 4],
      addedHeadLines: [],
      changedBaseLines: [],
      changedHeadLines: [],
    };

    const matches = commitsForSelection(history.commits, selection);
    const [latest, earlier] = matches;
    if (!latest || !earlier) throw new Error("Expected both commits");
    expect(matches.map((entry) => entry.sha)).toEqual(["bbbbbbbb", "aaaaaaaa"]);
    expect(commitEffectLabels(earlier, selection)).toEqual(["Removed lines 3"]);
    expect(commitEffectLabels(latest, selection)).toEqual([
      "Removed lines 2–4",
    ]);
  });
});
