import { z } from "zod";

export const evalCaseSchema = z.object({
  title: z.string().trim().min(1).max(180),
  path: z.string().trim().min(1).max(500),
  source: z.string().min(1).max(100_000),
  previousSource: z.string().max(100_000).default(""),
  finding: z.string().trim().min(1).max(10_000),
  existingCode: z.string().max(10_000).default(""),
  label: z.enum(["bug", "false_positive", "unlabeled"]),
  rationale: z.string().max(5_000).default(""),
  split: z.enum(["development", "holdout"]).default("development"),
  sourceFindingId: z.string().max(64).optional(),
});
export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalPrediction = "report" | "suppress" | "ungraded" | "error";
export interface EvalOutput {
  prediction: EvalPrediction;
  output: string;
  originalPrediction?: EvalPrediction;
  gradedBy?: string;
  gradedAt?: string;
  inputTokens: number;
  outputTokens: number;
}

/** Computes case-level metrics only for completed, human-labeled decisions. */
export function evalMetrics(
  rows: { label: EvalCase["label"]; prediction: EvalPrediction }[],
) {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0,
    excluded = 0;
  for (const row of rows) {
    if (
      row.label === "unlabeled" ||
      row.prediction === "error" ||
      row.prediction === "ungraded"
    ) {
      excluded++;
      continue;
    }
    if (row.label === "bug") {
      if (row.prediction === "report") tp++;
      else fn++;
    } else if (row.prediction === "report") fp++;
    else tn++;
  }
  return {
    tp,
    fp,
    tn,
    fn,
    excluded,
    graded: tp + fp + tn + fn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    falsePositiveRate: fp + tn ? fp / (fp + tn) : null,
  };
}
