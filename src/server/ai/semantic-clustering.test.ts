import { describe, expect, it } from "vitest";
import {
  enforceSemanticConceptCaps,
  MAX_CONCEPT_RATIONALE_LENGTH,
  MAX_CONCEPT_TITLE_LENGTH,
  semanticClusterJobInput,
  semanticPartitionErrors,
} from "./semantic-partition";

describe("semantic concept validation", () => {
  it("detects missing, duplicate, and invented unit IDs", () => {
    const [first, second, unknown] = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000099",
    ];
    const errors = semanticPartitionErrors(
      [first, second],
      [
        {
          title: "One",
          rationale: "Related",
          memberUnitIds: [first, first, unknown],
        },
      ],
    );
    expect(errors).toEqual({
      duplicate: [first],
      missing: [second],
      unknown: [unknown],
    });
  });

  it("deterministically splits oversized proposals without losing atoms", () => {
    const units = Array.from({ length: 12 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      path: `src/file-${index}.ts`,
      changedLineCount: 50,
      reviewOrder: index,
    }));
    const proposal = [
      {
        title: "One broad concern",
        rationale: "The model related these changes.",
        memberUnitIds: units.map(({ id }) => id),
      },
    ];
    const result = enforceSemanticConceptCaps(proposal, units);
    expect(result).toHaveLength(2);
    expect(result.flatMap(({ memberUnitIds }) => memberUnitIds)).toEqual(
      units.map(({ id }) => id),
    );
    expect(
      result.every(
        ({ memberUnitIds }) =>
          new Set(
            memberUnitIds.map(
              (id) => units.find((unit) => unit.id === id)?.path,
            ),
          ).size <= 10,
      ),
    ).toBe(true);
    expect(enforceSemanticConceptCaps(proposal, [...units].reverse())).toEqual(
      result,
    );
  });

  it("keeps split titles and rationales inside the persisted caps", () => {
    const units = Array.from({ length: 12 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      path: `src/file-${index}.ts`,
      changedLineCount: 50,
      reviewOrder: index,
    }));
    const result = enforceSemanticConceptCaps(
      [
        {
          title: "T".repeat(MAX_CONCEPT_TITLE_LENGTH),
          rationale: "R".repeat(MAX_CONCEPT_RATIONALE_LENGTH),
          memberUnitIds: units.map(({ id }) => id),
        },
      ],
      units,
    );
    expect(result.length).toBeGreaterThan(1);
    for (const concept of result) {
      expect(concept.title.length).toBeLessThanOrEqual(
        MAX_CONCEPT_TITLE_LENGTH,
      );
      expect(concept.rationale.length).toBeLessThanOrEqual(
        MAX_CONCEPT_RATIONALE_LENGTH,
      );
      expect(concept.title.trim()).toBe(concept.title);
      expect(concept.rationale.trim()).toBe(concept.rationale);
    }
    // The suffix has to survive truncation or the parts stop being labelled.
    expect(result[0]?.title).toContain("part 1/");
  });
});

describe("the job a clustering run reserves", () => {
  /**
   * The database check that decides whether an `ai_job` row may be written.
   *
   * Copied from `ai_job_question_context_check`: a question states a
   * reviewer's turn and is meaningless without the line and thread it was
   * asked at, so all three travel together or none of them do.
   */
  const questionContextHolds = (job: Record<string, unknown>) =>
    (job.question === undefined &&
      job.focusLine === undefined &&
      job.threadId === undefined) ||
    (job.question !== undefined &&
      job.focusLine !== undefined &&
      job.threadId !== undefined);

  it("names its layout without borrowing the question column", () => {
    // Layout identity used to travel in `question`, which a clustering run
    // has no focus line or thread for, so the check refused every row and
    // the feature could never start a job at all.
    const job = semanticClusterJobInput({
      pullRequestId: "11111111-1111-4111-8111-111111111111",
      layoutId: "22222222-2222-4222-8222-222222222222",
      layoutVersion: 3,
      userId: "user",
      subscribed: false,
    });

    expect(questionContextHolds(job)).toBe(true);
    expect(job).toMatchObject({
      kind: "semantic_cluster",
      layoutKey: "22222222-2222-4222-8222-222222222222:3",
    });
  });

  it("tells two revisions of the same layout apart", () => {
    /** Builds the layout key one revision of the layout would reserve. */
    const of = (layoutVersion: number) =>
      semanticClusterJobInput({
        pullRequestId: "11111111-1111-4111-8111-111111111111",
        layoutId: "22222222-2222-4222-8222-222222222222",
        layoutVersion,
        userId: "user",
        subscribed: false,
      }).layoutKey;

    expect(of(3)).not.toBe(of(4));
  });
});
