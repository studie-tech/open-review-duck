export interface RepositoryReportFinding {
  id: string;
  severity: string;
  category: string;
  title: string;
  body: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  existingCode: string;
  suggestionCode: string | null;
}

interface RepositoryReportInput {
  repository: string;
  branch: string;
  revision: string;
  purpose: "code" | "compliance";
  findings: readonly RepositoryReportFinding[];
}

/** Selects a Markdown fence longer than any tick run in source. */
function codeFence(source: string) {
  const longest = Math.max(
    2,
    ...[...source.matchAll(/`+/g)].map(([ticks]) => ticks.length),
  );
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${source}\n${fence}`;
}

/** Builds a self-contained fixing brief safe to paste into another agent. */
export function repositoryReviewReport(input: RepositoryReportInput) {
  const heading =
    input.purpose === "compliance"
      ? "Repository compliance report"
      : "Repository code-review report";
  const findings = input.findings.map((finding, index) => {
    const location = finding.path
      ? `${finding.path}${
          finding.startLine
            ? `:${finding.startLine}${
                finding.endLine && finding.endLine !== finding.startLine
                  ? `-${finding.endLine}`
                  : ""
              }`
            : ""
        }`
      : "Repository-wide";
    return [
      `## ${index + 1}. ${finding.title}`,
      `- Severity: ${finding.severity}`,
      `- Category: ${finding.category}`,
      `- Location: ${location}`,
      "",
      finding.body,
      ...(finding.existingCode
        ? ["", "Current code:", "", codeFence(finding.existingCode)]
        : []),
      ...(finding.suggestionCode
        ? ["", "Suggested direction:", "", codeFence(finding.suggestionCode)]
        : []),
    ].join("\n");
  });
  return [
    `# ${heading}`,
    "",
    `- Repository: ${input.repository}`,
    `- Branch: ${input.branch}`,
    `- Revision: ${input.revision}`,
    `- Findings selected: ${input.findings.length}`,
    "",
    "Please fix the findings below. Validate each claim against the repository, preserve intended behavior, and run the relevant tests after making changes.",
    "",
    ...findings.flatMap((finding, index) =>
      index === 0 ? [finding] : ["---", "", finding],
    ),
    "",
  ].join("\n");
}

/** Builds a portable, bounded filename for a Markdown fixing brief. */
export function repositoryReportFilename(
  repository: string,
  branch: string,
  purpose: "code" | "compliance",
) {
  const safe = `${repository}-${branch}-${purpose}-report`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return `${safe || "repository-review"}.md`;
}
