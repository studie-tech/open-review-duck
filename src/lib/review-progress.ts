import {
  isDataOrGeneratedReviewPath,
  isReviewMarkdownFile,
  reviewPathExtension,
} from "~/lib/review-source-display";

export interface ProgressUnit {
  path: string;
  language: string;
  kind: string;
  status: string;
  changedLineCount: number;
}

export type ProgressCategory = "code" | "data" | "docs" | "other";

export const progressCategories: { key: ProgressCategory; label: string }[] = [
  { key: "code", label: "Code" },
  { key: "data", label: "Data & config" },
  { key: "docs", label: "Documentation" },
  { key: "other", label: "Other files" },
];

/** Classifies review work without treating serialized data or unknown text as code. */
export function progressFileCategory(
  path: string,
  language: string,
): ProgressCategory {
  if (
    isDataOrGeneratedReviewPath(path) ||
    [
      "csv",
      "tsv",
      "ini",
      "env",
      "properties",
      "tf",
      "tfvars",
      "hcl",
      "conf",
      "cfg",
    ].includes(reviewPathExtension(path)) ||
    ["json", "json5", "yaml", "toml", "xml", "hcl", "ini"].includes(language)
  )
    return "data";
  if (
    isReviewMarkdownFile({ path, language }) ||
    ["txt", "rst", "adoc"].includes(reviewPathExtension(path))
  )
    return "docs";
  if (language && !["text", "binary"].includes(language)) return "code";
  return "other";
}

/** Aggregates the analyzed changed-line ownership, including deleted lines once. */
export function reviewProgressBreakdown(units: readonly ProgressUnit[]) {
  const files = new Map<
    string,
    { category: ProgressCategory; type: string; units: ProgressUnit[] }
  >();
  for (const unit of units) {
    let file = files.get(unit.path);
    if (!file) {
      const extension = reviewPathExtension(unit.path);
      const name = unit.path.split("/").pop() ?? unit.path;
      file = {
        category:
          unit.kind === "binary"
            ? "other"
            : progressFileCategory(unit.path, unit.language),
        type:
          unit.kind === "binary"
            ? "Binary"
            : extension
              ? `.${extension}`
              : name,
        units: [],
      };
      files.set(unit.path, file);
    }
    file.units.push(unit);
  }
  return progressCategories
    .map(({ key, label }) => {
      const types = new Map<
        string,
        { label: string; files: number; lines: number; reviewedLines: number }
      >();
      for (const file of files.values()) {
        if (file.category !== key) continue;
        const type = types.get(file.type) ?? {
          label: file.type,
          files: 0,
          lines: 0,
          reviewedLines: 0,
        };
        type.files += 1;
        for (const unit of file.units) {
          // Binary units use a synthetic count for review coverage, not a text line.
          const lines = unit.kind === "binary" ? 0 : unit.changedLineCount;
          type.lines += lines;
          if (unit.status === "signed_off") type.reviewedLines += lines;
        }
        types.set(file.type, type);
      }
      const entries = [...types.values()].sort(
        (a, b) => b.lines - a.lines || a.label.localeCompare(b.label),
      );
      return {
        key,
        label,
        types: entries,
        files: entries.reduce((sum, type) => sum + type.files, 0),
        lines: entries.reduce((sum, type) => sum + type.lines, 0),
        reviewedLines: entries.reduce(
          (sum, type) => sum + type.reviewedLines,
          0,
        ),
      };
    })
    .filter(({ files }) => files > 0);
}
