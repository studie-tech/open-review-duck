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

/**
 * Wraps text another party authored in a named data tag.
 *
 * The tag is the boundary an agent is told to respect, so the text must not
 * be able to end it early: any attempt to open or close the same tag inside
 * the body loses its angle bracket. Markdown escaping is applied by callers
 * where the text is prose; this only guards the boundary itself.
 */
export function untrustedBlock(tag: string, body: string) {
  const escaped = body.replace(
    new RegExp(`<(/?)\\s*${tag}\\b`, "gi"),
    (_match, slash: string) => `&lt;${slash}${tag}`,
  );
  return `<${tag}>\n${escaped}\n</${tag}>`;
}
