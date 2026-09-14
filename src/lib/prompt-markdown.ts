/** Selects a Markdown fence longer than any tick run in source. */
export function codeFence(source: string) {
  const longest = Math.max(
    2,
    ...[...source.matchAll(/`+/g)].map(([ticks]) => ticks.length),
  );
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${source}\n${fence}`;
}

/**
 * Neutralizes Markdown structure inside text another party authored.
 *
 * Finding bodies, review comments, and check descriptions come from a model
 * or from the provider, so a crafted heading or rule could otherwise forge
 * instructions in a brief another agent is told to execute.
 */
export function escapeMarkdownText(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("#", "\\#")
    .replaceAll("---", "\\-\\-\\-")
    .replaceAll("`", "\\`");
}
