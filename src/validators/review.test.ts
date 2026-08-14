import { describe, expect, it } from "vitest";
import {
  awaitResponseConceptSchema,
  importTargetSchema,
  MAX_CONCEPT_LAYOUT_MEMBERS,
  providerReviewDecisionSchema,
  publishReviewCommentSchema,
  replacePersonalConceptLayoutSchema,
  replyToReviewThreadSchema,
  signOffBatchSchema,
} from "./review";

describe("provider review decision validation", () => {
  it("accepts bounded provider decisions and trims an optional reason", () => {
    expect(
      providerReviewDecisionSchema.parse({
        pullRequestId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        action: "request_changes",
        body: "  Cover the retry path.  ",
      }),
    ).toEqual({
      pullRequestId: "399ea3a7-2860-4eb9-9243-28627e87898d",
      action: "request_changes",
      body: "Cover the retry path.",
    });
  });

  it("rejects unknown actions and oversized reasons", () => {
    expect(
      providerReviewDecisionSchema.safeParse({
        pullRequestId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        action: "merge",
      }).success,
    ).toBe(false);
    expect(
      providerReviewDecisionSchema.safeParse({
        pullRequestId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        action: "request_changes",
        body: "x".repeat(10_001),
      }).success,
    ).toBe(false);
  });
});

/** Creates one valid sign-off input for batch-boundary tests. */
const signOff = (unitId: string) => ({
  unitId,
  durationSeconds: 10,
});

describe("sign-off batch validation", () => {
  it("accepts between two and twenty sign-offs", () => {
    expect(
      signOffBatchSchema.safeParse({
        signOffs: [
          signOff("399ea3a7-2860-4eb9-9243-28627e87898d"),
          signOff("86f28e99-40ab-4418-933a-48cfd57eb9f5"),
        ],
      }).success,
    ).toBe(true);
    expect(
      signOffBatchSchema.safeParse({
        signOffs: Array.from({ length: 20 }, (_, index) =>
          signOff(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
        ),
      }).success,
    ).toBe(true);
  });

  it("rejects single-item and oversized batches", () => {
    expect(
      signOffBatchSchema.safeParse({
        signOffs: [signOff("399ea3a7-2860-4eb9-9243-28627e87898d")],
      }).success,
    ).toBe(false);
    expect(
      signOffBatchSchema.safeParse({
        signOffs: Array.from({ length: 21 }, (_, index) =>
          signOff(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
        ),
      }).success,
    ).toBe(false);
    expect(
      signOffBatchSchema.safeParse({
        signOffs: [
          signOff("399ea3a7-2860-4eb9-9243-28627e87898d"),
          signOff("399ea3a7-2860-4eb9-9243-28627e87898d"),
        ],
      }).success,
    ).toBe(false);
  });
});

describe("review comment validation", () => {
  it("accepts human feedback with a selected line", () => {
    expect(
      publishReviewCommentSchema.safeParse({
        unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        line: 12,
        body: "Could this branch return early?",
      }).success,
    ).toBe(true);
  });

  it("accepts a reply to an existing provider conversation", () => {
    expect(
      replyToReviewThreadSchema.safeParse({
        unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        threadExternalId: "discussion-42",
        body: "That makes sense. Could we also cover the retry path?",
      }).success,
    ).toBe(true);
  });

  it("accepts a reference to a persisted AI finding", () => {
    expect(
      publishReviewCommentSchema.safeParse({
        unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        line: 12,
        aiJobId: "86f28e99-40ab-4418-933a-48cfd57eb9f5",
        aiFindingIndex: 0,
      }).success,
    ).toBe(true);
  });

  it("accepts an edited comment proposed by a focused AI conversation", () => {
    expect(
      publishReviewCommentSchema.safeParse({
        unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        line: 12,
        body: "Could this keep the authorization guard?",
        aiJobId: "86f28e99-40ab-4418-933a-48cfd57eb9f5",
        aiCommentIndex: 0,
      }).success,
    ).toBe(true);
  });

  it("accepts a reference to a deep-review finding row", () => {
    expect(
      publishReviewCommentSchema.safeParse({
        unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        line: 12,
        aiJobId: "86f28e99-40ab-4418-933a-48cfd57eb9f5",
        aiFindingId: "b9f1c0d2e3a4b5c6d7e8f9a0b1c2d3e4",
      }).success,
    ).toBe(true);
  });

  it("rejects incomplete AI references and empty human feedback", () => {
    expect(
      publishReviewCommentSchema.safeParse({
        unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        line: 12,
        aiJobId: "86f28e99-40ab-4418-933a-48cfd57eb9f5",
        aiFindingIndex: 0,
        aiCommentIndex: 0,
      }).success,
    ).toBe(false);
    expect(
      publishReviewCommentSchema.safeParse({
        unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        line: 12,
        aiJobId: "86f28e99-40ab-4418-933a-48cfd57eb9f5",
      }).success,
    ).toBe(false);
    expect(
      publishReviewCommentSchema.safeParse({
        unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        line: 12,
        body: " ",
      }).success,
    ).toBe(false);
  });

  it("rejects a finding row named alongside either index", () => {
    // The three AI keys select the comment body from three different places,
    // so any pair of them leaves the publisher without a single answer.
    expect(
      publishReviewCommentSchema.safeParse({
        unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        line: 12,
        aiJobId: "86f28e99-40ab-4418-933a-48cfd57eb9f5",
        aiFindingId: "b9f1c0d2e3a4b5c6d7e8f9a0b1c2d3e4",
        aiFindingIndex: 0,
      }).success,
    ).toBe(false);
    expect(
      publishReviewCommentSchema.safeParse({
        unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        line: 12,
        aiJobId: "86f28e99-40ab-4418-933a-48cfd57eb9f5",
        aiFindingId: "b9f1c0d2e3a4b5c6d7e8f9a0b1c2d3e4",
        aiCommentIndex: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects a finding row without the job that authorizes it", () => {
    expect(
      publishReviewCommentSchema.safeParse({
        unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        line: 12,
        aiFindingId: "b9f1c0d2e3a4b5c6d7e8f9a0b1c2d3e4",
      }).success,
    ).toBe(false);
    expect(
      publishReviewCommentSchema.safeParse({
        unitId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        line: 12,
        aiJobId: "86f28e99-40ab-4418-933a-48cfd57eb9f5",
        aiFindingId: "  ",
      }).success,
    ).toBe(false);
  });
});

describe("import target validation", () => {
  it("accepts a bounded local import lookup", () => {
    expect(
      importTargetSchema.safeParse({
        pullRequestId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        sourcePath: "src/lib/review-navigation.test.ts",
        sourceLanguage: "typescript",
        specifier: "./review-navigation",
        imported: "nextPendingReviewIndex",
        kind: "named",
      }).success,
    ).toBe(true);
  });

  it("rejects unsupported languages and unbounded values", () => {
    expect(
      importTargetSchema.safeParse({
        pullRequestId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        sourcePath: "main.bf",
        sourceLanguage: "brainfuck",
        specifier: "./review",
        imported: "Review",
        kind: "named",
      }).success,
    ).toBe(false);
  });
});

describe("personal concept layout validation", () => {
  /** Builds a layout of `conceptCount` concepts holding `each` members apiece. */
  const layout = (conceptCount: number, each: number) => ({
    pullRequestId: "11111111-1111-4111-8111-111111111111",
    snapshotId: "22222222-2222-4222-8222-222222222222",
    expectedVersion: 1,
    source: "manual" as const,
    concepts: Array.from({ length: conceptCount }, (_, concept) => ({
      title: `Concept ${concept}`,
      memberUnitIds: Array.from(
        { length: each },
        (_, member) =>
          `33333333-3333-4333-8333-${String(concept * each + member).padStart(12, "0")}`,
      ),
    })),
  });

  it("accepts a layout up to the total member bound", () => {
    expect(
      replacePersonalConceptLayoutSchema.safeParse(
        layout(2, MAX_CONCEPT_LAYOUT_MEMBERS / 2),
      ).success,
    ).toBe(true);
  });

  it("rejects a layout whose concepts together exceed it", () => {
    // Each concept is within its own cap; only the total is over, which is
    // what the two caps multiplying used to allow.
    expect(
      replacePersonalConceptLayoutSchema.safeParse(
        layout(3, MAX_CONCEPT_LAYOUT_MEMBERS / 2),
      ).success,
    ).toBe(false);
  });
});

describe("concept wait validation", () => {
  it("names the concept and the layout it was read from", () => {
    expect(
      awaitResponseConceptSchema.safeParse({
        conceptId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        layoutId: "86f28e99-40ab-4418-933a-48cfd57eb9f5",
        layoutVersion: 3,
      }).success,
    ).toBe(true);
  });

  it("rejects a wait that carries no layout version", () => {
    // The version is what fails a wait issued against a grouping the reviewer
    // has since re-cut, so a request without one cannot be honoured.
    expect(
      awaitResponseConceptSchema.safeParse({
        conceptId: "399ea3a7-2860-4eb9-9243-28627e87898d",
        layoutId: "86f28e99-40ab-4418-933a-48cfd57eb9f5",
      }).success,
    ).toBe(false);
  });
});
