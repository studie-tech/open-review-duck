import { sideBySideDiff } from "./side-by-side-diff";

export interface MarkdownChanges {
  previous: readonly number[];
  current: readonly number[];
}

/** Maps changed source lines to each rendered Markdown revision. */
export function markdownChangedLines(
  previousSource: string,
  currentSource: string,
): MarkdownChanges {
  const previous: number[] = [];
  const current: number[] = [];
  for (const row of sideBySideDiff(previousSource, currentSource)) {
    if (row.kind === "unchanged") continue;
    if (row.previousIndex !== undefined) previous.push(row.previousIndex + 1);
    if (row.currentIndex !== undefined) current.push(row.currentIndex + 1);
  }
  return { previous, current };
}

interface MarkdownNode {
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start: { line: number }; end: { line: number } };
  children?: MarkdownNode[];
}

const changeBlocks = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "tr",
  "summary",
  "hr",
]);

/** Marks the smallest rendered blocks covering changed source lines after sanitization. */
export function rehypeMarkdownChanges(options: {
  lines: readonly number[];
  side: "previous" | "current";
}) {
  return (tree: MarkdownNode) => {
    /** Returns lines already marked in descendants to avoid tinting entire lists. */
    function visit(node: MarkdownNode): Set<number> {
      const covered = new Set<number>();
      for (const child of node.children ?? []) {
        for (const line of visit(child)) covered.add(line);
      }
      if (changeBlocks.has(node.tagName ?? "") && node.position) {
        const { start, end } = node.position;
        const ownChanges = options.lines.filter(
          (line) =>
            line >= start.line && line <= end.line && !covered.has(line),
        );
        if (ownChanges.length > 0) {
          node.properties ??= {};
          node.properties.dataMarkdownChange = options.side;
          for (const line of ownChanges) covered.add(line);
        }
      }
      return covered;
    }
    visit(tree);
  };
}

/** Passes trusted diff annotations through custom Markdown renderers. */
export function markdownChangeAttributes(node: MarkdownNode | undefined) {
  const side = node?.properties?.dataMarkdownChange;
  return side === "previous" || side === "current"
    ? { "data-markdown-change": side }
    : {};
}
