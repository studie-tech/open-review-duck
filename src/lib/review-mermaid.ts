/** Fence languages that always mean a Mermaid diagram. */
const MERMAID_LANGUAGES = new Set(["mermaid", "mmd"]);

/**
 * Flowchart tokens authors often reuse as node ids.
 *
 * `graph["Label"]` or `end --> next` is valid-looking Markdown and invalid
 * Mermaid: the parser treats the id as a keyword. Prefixing those ids keeps
 * the diagram drawable without asking the author to rename the architecture.
 */
const RESERVED_FLOWCHART_NODE_IDS = [
  "graph",
  "end",
  "subgraph",
  "flowchart",
  "style",
  "class",
  "classDef",
  "click",
  "direction",
  "linkStyle",
] as const;

/**
 * Opening keywords Mermaid accepts for a diagram body.
 *
 * Unlabeled Markdown fences still reach Preview as a code block. A reviewer
 * reading a design doc should not have to remember the `mermaid` tag for a
 * flowchart or class diagram to render.
 */
const MERMAID_DIAGRAM_START =
  /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|sankey-beta|xychart-beta|kanban|architecture-beta|packet-beta|block-beta|zenuml)\b/;

/**
 * Reports whether a fenced Markdown body should render as a Mermaid diagram.
 *
 * Named `mermaid` fences always qualify. A fence with no language, or a
 * generic `text` fence, qualifies when the body itself is a Mermaid diagram
 * so UML and flowcharts in documentation still draw.
 */
export function isMermaidSource(language: string | undefined, source: string) {
  const normalizedLanguage = language?.trim().toLowerCase();
  if (normalizedLanguage && MERMAID_LANGUAGES.has(normalizedLanguage)) {
    return source.trim().length > 0;
  }
  if (
    normalizedLanguage &&
    normalizedLanguage !== "text" &&
    normalizedLanguage !== "plain"
  ) {
    return false;
  }
  return MERMAID_DIAGRAM_START.test(source.trim());
}

/**
 * Rewrites reserved flowchart node ids so Mermaid can parse the diagram.
 *
 * Only flowchart and `graph` documents are touched. Sequence, class, and
 * other UML diagrams keep their original source.
 */
export function prepareMermaidSource(source: string) {
  const trimmed = source.trim();
  if (!/^(?:flowchart|graph)\b/.test(trimmed)) return trimmed;
  let next = trimmed;
  for (const id of RESERVED_FLOWCHART_NODE_IDS) {
    next = next.replace(
      new RegExp(`\\b${id}\\b(?=\\s*(?:[\\[({]|-->|---|==)|\\s*$)`, "gm"),
      `n_${id}`,
    );
  }
  return next;
}
