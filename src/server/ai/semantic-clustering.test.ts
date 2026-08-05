import { describe, expect, it } from "vitest";
import {
  enforceSemanticConceptCaps,
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
});
