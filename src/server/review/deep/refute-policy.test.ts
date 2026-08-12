import { describe, expect, it } from "vitest";
import {
  applyRefuteVerdicts,
  type RefuteVote,
  refuteVoteErrors,
} from "./refute-policy";

const snapshotPaths = ["src/app/page.tsx", "src/lib/auth.ts"];

/** Builds a refutation that clears every evidentiary gate. */
function grounded(id: string, overrides: Partial<RefuteVote> = {}): RefuteVote {
  return {
    id,
    verdict: "refuted",
    refutation: "The nullish coalescing on line 12 already guards this.",
    evidencePath: "src/lib/auth.ts",
    evidenceLine: 12,
    ...overrides,
  };
}

describe("refuteVoteErrors", () => {
  it("accepts a batch with one vote per finding", () => {
    expect(
      refuteVoteErrors({
        votes: [grounded("f-1"), { id: "f-2", verdict: "not_refuted" }],
        findingIds: ["f-1", "f-2"],
        snapshotPaths,
      }),
    ).toEqual([]);
  });

  it("rejects the batch when one finding is voted on twice", () => {
    const errors = refuteVoteErrors({
      votes: [grounded("f-1"), { id: "f-1", verdict: "not_refuted" }],
      findingIds: ["f-1", "f-2"],
      snapshotPaths,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("f-1");
  });

  it("reports a repeated id once however often it repeats", () => {
    expect(
      refuteVoteErrors({
        votes: [grounded("f-1"), grounded("f-1"), grounded("f-1")],
        findingIds: ["f-1"],
        snapshotPaths,
      }),
    ).toHaveLength(1);
  });

  it("rejects the batch on a duplicate of an unknown id", () => {
    expect(
      refuteVoteErrors({
        votes: [grounded("ghost"), grounded("ghost")],
        findingIds: ["f-1"],
        snapshotPaths,
      }),
    ).toHaveLength(1);
  });

  it("accepts votes for ids that were never sent", () => {
    expect(
      refuteVoteErrors({
        votes: [grounded("ghost")],
        findingIds: ["f-1"],
        snapshotPaths,
      }),
    ).toEqual([]);
  });

  it("accepts a batch that omits findings entirely", () => {
    expect(
      refuteVoteErrors({
        votes: [],
        findingIds: ["f-1", "f-2"],
        snapshotPaths,
      }),
    ).toEqual([]);
  });
});

describe("applyRefuteVerdicts", () => {
  it("leaves a finding nobody voted on unverified", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1", "f-2"],
      votes: [{ id: "f-1", verdict: "not_refuted" }],
      snapshotPaths,
    });
    expect(verdicts.get("f-2")).toEqual({
      verdict: "unverified",
      reason: null,
    });
  });

  it("returns a verdict for every finding id and nothing else", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1", "f-2"],
      votes: [grounded("f-1"), grounded("ghost")],
      snapshotPaths,
    });
    expect([...verdicts.keys()]).toEqual(["f-1", "f-2"]);
  });

  it("records a defended finding as not_refuted without a reason", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1"],
      votes: [{ id: "f-1", verdict: "not_refuted" }],
      snapshotPaths,
    });
    expect(verdicts.get("f-1")).toEqual({
      verdict: "not_refuted",
      reason: null,
    });
  });

  it("refutes a finding whose citation resolves in the snapshot", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1"],
      votes: [grounded("f-1")],
      snapshotPaths,
    });
    expect(verdicts.get("f-1")?.verdict).toBe("refuted");
    expect(verdicts.get("f-1")?.reason).toContain(
      "line 12 already guards this",
    );
  });

  it("keeps a finding refuted with no refutation text", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1", "f-2"],
      votes: [
        grounded("f-1", { refutation: undefined }),
        grounded("f-2", { refutation: "   " }),
      ],
      snapshotPaths,
    });
    expect(verdicts.get("f-1")).toEqual({
      verdict: "unverified",
      reason: null,
    });
    expect(verdicts.get("f-2")).toEqual({
      verdict: "unverified",
      reason: null,
    });
  });

  it("keeps a finding whose refutation cites a path outside the snapshot", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1"],
      votes: [grounded("f-1", { evidencePath: "src/lib/invented.ts" })],
      snapshotPaths,
    });
    expect(verdicts.get("f-1")).toEqual({
      verdict: "unverified",
      reason: null,
    });
  });

  it("keeps a finding whose refutation cites no path at all", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1"],
      votes: [grounded("f-1", { evidencePath: undefined })],
      snapshotPaths,
    });
    expect(verdicts.get("f-1")?.verdict).toBe("unverified");
  });

  it("does not treat a path prefix as a snapshot match", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1"],
      votes: [grounded("f-1", { evidencePath: "src/lib" })],
      snapshotPaths,
    });
    expect(verdicts.get("f-1")?.verdict).toBe("unverified");
  });

  it("keeps every finding unverified when any id is duplicated", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1", "f-2", "f-3"],
      votes: [
        grounded("f-1"),
        grounded("f-2"),
        { id: "f-2", verdict: "not_refuted" },
        grounded("f-3"),
      ],
      snapshotPaths,
    });
    for (const id of ["f-1", "f-2", "f-3"]) {
      expect(verdicts.get(id)).toEqual({ verdict: "unverified", reason: null });
    }
  });

  it("keeps a finding whose verdict is not one we recognize", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1"],
      votes: [{ id: "f-1", verdict: "dismissed" } as unknown as RefuteVote],
      snapshotPaths,
    });
    expect(verdicts.get("f-1")).toEqual({
      verdict: "unverified",
      reason: null,
    });
  });

  it("keeps a finding whose refutation text is not a string", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1"],
      votes: [
        grounded("f-1", { refutation: 7 as unknown as string }),
      ] as RefuteVote[],
      snapshotPaths,
    });
    expect(verdicts.get("f-1")?.verdict).toBe("unverified");
  });

  it("refutes without an evidenceLine, which is carried but not gating", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1"],
      votes: [grounded("f-1", { evidenceLine: undefined })],
      snapshotPaths,
    });
    expect(verdicts.get("f-1")?.verdict).toBe("refuted");
  });

  it("keeps every finding unverified when the snapshot has no paths", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1"],
      votes: [grounded("f-1")],
      snapshotPaths: [],
    });
    expect(verdicts.get("f-1")?.verdict).toBe("unverified");
  });

  it("resolves each finding independently within a clean batch", () => {
    const verdicts = applyRefuteVerdicts({
      findingIds: ["f-1", "f-2", "f-3", "f-4"],
      votes: [
        grounded("f-1"),
        { id: "f-2", verdict: "not_refuted" },
        grounded("f-3", { evidencePath: "vendor/other.ts" }),
      ],
      snapshotPaths,
    });
    expect([...verdicts.values()].map((entry) => entry.verdict)).toEqual([
      "refuted",
      "not_refuted",
      "unverified",
      "unverified",
    ]);
  });
});
