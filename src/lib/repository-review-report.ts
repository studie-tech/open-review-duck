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

/**
 * Neutralizes Markdown structure inside finding-authored text.
 *
 * Titles and bodies come from a model, so a crafted heading or rule could
 * otherwise forge instructions in the brief another agent is told to execute.
 */
function escapeMarkdownText(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("#", "\\#")
    .replaceAll("---", "\\-\\-\\-")
    .replaceAll("`", "\\`");
}

/** Builds a self-contained fixing brief safe to paste into another agent. */
export function repositoryReviewReport(input: RepositoryReportInput) {
  const heading =
    input.purpose === "compliance"
      ? "Repository compliance report"
      : "Repository code-review report";
  const findings = input.findings.map((finding, index) => {
    // Line numbers are positions, so only the absence of one (null) may drop
    // the location — a stored 0 would otherwise silently hide where to look.
    const startLine =
      finding.startLine !== null && finding.startLine >= 0
        ? finding.startLine
        : null;
    const location = finding.path
      ? `${finding.path}${
          startLine !== null
            ? `:${startLine}${
                finding.endLine !== null && finding.endLine > startLine
                  ? `-${finding.endLine}`
                  : ""
              }`
            : ""
        }`
      : "Repository-wide";
    return [
      `## ${index + 1}. ${escapeMarkdownText(finding.title)}`,
      `- Severity: ${escapeMarkdownText(finding.severity)}`,
      `- Category: ${escapeMarkdownText(finding.category)}`,
      `- Location: ${escapeMarkdownText(location)}`,
      "",
      escapeMarkdownText(finding.body),
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

/**
 * Short synchronous fingerprint used only to disambiguate truncated filenames.
 * Not cryptographic; the brief's integrity lives in the file content itself.
 */
function filenameDigest(input: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

/** Builds a portable, bounded filename for a Markdown fixing brief. */
export function repositoryReportFilename(
  repository: string,
  branch: string,
  purpose: "code" | "compliance",
) {
  const raw = `${repository}-${branch}-${purpose}-report`;
  const safe = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (safe.length <= 120) {
    return `${safe || "repository-review"}.md`;
  }
  // Distinct long names must not collapse onto one truncated filename and
  // silently overwrite earlier briefs, so the tail carries a stable digest.
  return `${safe.slice(0, 112)}-${filenameDigest(raw)}.md`;
}
