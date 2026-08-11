import { z } from "zod";
import {
  MAX_CONCEPT_CHANGED_LINES,
  MAX_CONCEPT_FILES,
} from "~/server/analysis/concepts";

export const MAX_CONCEPT_TITLE_LENGTH = 200;
export const MAX_CONCEPT_RATIONALE_LENGTH = 1_000;

export const semanticPartitionSchema = z.object({
  concepts: z.array(
    z.object({
      title: z.string().min(1).max(MAX_CONCEPT_TITLE_LENGTH),
      rationale: z.string().min(1).max(MAX_CONCEPT_RATIONALE_LENGTH),
      memberUnitIds: z.array(z.string().uuid()).min(1),
    }),
  ),
});

/** Appends a suffix while keeping the result within its persisted column cap. */
function withSuffixWithinCap(base: string, suffix: string, cap: number) {
  const trimmed = base.slice(0, Math.max(0, cap - suffix.length)).trimEnd();
  return trimmed.length > 0
    ? `${trimmed}${suffix}`
    : suffix.trim().slice(0, cap);
}

/** Reports exact-membership violations without accepting partial AI output. */
export function semanticPartitionErrors(
  unitIds: string[],
  concepts: z.infer<typeof semanticPartitionSchema>["concepts"],
) {
  const expected = new Set(unitIds);
  const counts = new Map<string, number>();
  const unknown: string[] = [];
  for (const id of concepts.flatMap(({ memberUnitIds }) => memberUnitIds)) {
    if (!expected.has(id)) unknown.push(id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const missing = unitIds.filter((id) => !counts.has(id));
  const duplicate = [...counts]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  return { duplicate, missing, unknown };
}

/** Splits oversized AI groups without dropping or subdividing atomic units. */
export function enforceSemanticConceptCaps(
  concepts: z.infer<typeof semanticPartitionSchema>["concepts"],
  units: Array<{
    id: string;
    path: string;
    changedLineCount: number;
    reviewOrder: number;
  }>,
) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  return concepts.flatMap((concept) => {
    const ordered = concept.memberUnitIds
      .map((id) => byId.get(id))
      .filter((unit): unit is (typeof units)[number] => Boolean(unit))
      .sort(
        (left, right) =>
          left.reviewOrder - right.reviewOrder ||
          left.id.localeCompare(right.id),
      );
    const chunks: (typeof ordered)[] = [];
    let current: typeof ordered = [];
    for (const unit of ordered) {
      const candidate = [...current, unit];
      const files = new Set(candidate.map(({ path }) => path)).size;
      const lines = candidate.reduce(
        (total, member) => total + member.changedLineCount,
        0,
      );
      if (
        current.length > 0 &&
        (files > MAX_CONCEPT_FILES || lines > MAX_CONCEPT_CHANGED_LINES)
      ) {
        chunks.push(current);
        current = [unit];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) chunks.push(current);
    return chunks.map((chunk, index) => ({
      // A model may return a title or rationale already at its cap. Truncate
      // before appending so the split suffix cannot overflow the same limit
      // that the persisting mutation revalidates.
      title:
        chunks.length === 1
          ? concept.title
          : withSuffixWithinCap(
              concept.title,
              ` · part ${index + 1}/${chunks.length}`,
              MAX_CONCEPT_TITLE_LENGTH,
            ),
      rationale:
        chunks.length === 1
          ? concept.rationale
          : withSuffixWithinCap(
              concept.rationale,
              " Split deterministically to respect review size limits.",
              MAX_CONCEPT_RATIONALE_LENGTH,
            ),
      memberUnitIds: chunk.map(({ id }) => id),
    }));
  });
}

/**
 * Describes the job one clustering run reserves.
 *
 * The layout it proposes for travels in `layoutKey`, not in `question`: a
 * question states a reviewer's turn and the database checks it against the
 * focus line and thread it was asked at, neither of which a clustering run
 * has. Naming the layout there made every one of these rows unwritable.
 */
export function semanticClusterJobInput(input: {
  pullRequestId: string;
  layoutId: string;
  layoutVersion: number;
  userId: string;
  subscribed: boolean;
}) {
  return {
    pullRequestId: input.pullRequestId,
    kind: "semantic_cluster" as const,
    layoutKey: `${input.layoutId}:${input.layoutVersion}`,
    userId: input.userId,
    subscribed: input.subscribed,
  };
}
