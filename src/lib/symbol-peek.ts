import { builtinTypes, keywords, type SyntaxToken } from "./highlight-tokens";
import { findImportedDeclarationLine } from "./import-navigation";

/** Longest excerpt a definition preview shows before the reader scrolls it. */
export const SYMBOL_PEEK_MAXIMUM_LINES = 18;

/** Width the card is rendered at, and the width its placement is solved for. */
export const SYMBOL_PEEK_CARD_WIDTH = 460;

/** The shape of a name a definition can be looked up for. */
export const SYMBOL_PATTERN = "^[A-Za-z_$][\\w$]*$";

/** How long the pointer rests on a name before its definition is fetched. */
export const SYMBOL_PEEK_HOVER_DELAY_MS = 350;

/**
 * How long the card survives the pointer leaving the name it belongs to.
 *
 * The gap between a name and the card below it is dead space the pointer has
 * to cross, and a card that closed on the way would be unreachable.
 */
export const SYMBOL_PEEK_CLOSE_DELAY_MS = 180;

/** The attribute a diff token carries so the pointer can find its name. */
export const SYMBOL_PEEK_ATTRIBUTE = "data-review-symbol";

/**
 * The attribute naming the line a peekable token was rendered on.
 *
 * A definition is only worth showing when it is somewhere else, so the lookup
 * has to say where the reviewer is reading the name from.
 */
export const SYMBOL_PEEK_LINE_ATTRIBUTE = "data-review-symbol-line";

const IDENTIFIER = new RegExp(SYMBOL_PATTERN);
const NON_NAME_PREFIXES = [
  "tok-string",
  "tok-comment",
  "tok-number",
  "tok-operator",
  "tok-meta",
  "tok-bool",
  "tok-atom",
];

/**
 * Decides whether a highlighted token names something worth looking up.
 *
 * Only declared names can have a definition, so string bodies, comments,
 * numbers, operators and the language's own keywords are excluded before a
 * single lookup is issued. Unclassified tokens stay eligible because the
 * lexical fallback highlighter leaves plain identifiers unclassed.
 *
 * Reserved-word exclusion uses the token text because syntax classes can also
 * cover name-bearing constructs such as Python keyword arguments. Imported
 * constants written as `name=VALUE` must still open a definition.
 */
export function isPeekableToken(
  token: Pick<SyntaxToken, "className" | "text">,
) {
  const text = token.text;
  if (!IDENTIFIER.test(text)) return false;
  const lower = text.toLowerCase();
  if (keywords.has(lower) || builtinTypes.has(lower)) return false;
  return !NON_NAME_PREFIXES.some((prefix) =>
    token.className.startsWith(prefix),
  );
}

/** Attributes the pointer uses to name one token for a definition lookup. */
export function symbolPeekAttributes(symbol: string, line?: number) {
  if (!IDENTIFIER.test(symbol)) return undefined;
  return {
    [SYMBOL_PEEK_ATTRIBUTE]: symbol,
    [SYMBOL_PEEK_LINE_ATTRIBUTE]: line,
  };
}

/**
 * Reports that a declaration is the very code the name was read from.
 *
 * Reading a declaration's own name, or a name used inside the body it opens,
 * has nothing to look up: the answer is the lines already on screen.
 */
export function definitionIsWhereTheNameWasRead(
  definition: {
    endLine: number;
    focusLine?: number;
    path: string;
    startLine: number;
  },
  read: { line?: number; path: string },
) {
  if (read.line === undefined || definition.path !== read.path) return false;
  if (definition.focusLine !== undefined) {
    return read.line === definition.focusLine;
  }
  return read.line >= definition.startLine && read.line <= definition.endLine;
}

/** Lines of context kept above a scanned same-file declaration. */
const SAME_FILE_PEEK_LEAD_LINES = 2;

/**
 * Infers the kind badge from the line that declared the name.
 *
 * A source scan never produced a review unit, so the declaration's own
 * keyword is the only kind the card can honestly show.
 */
function declarationKindFromLine(line: string) {
  if (/\b(?:type|interface|enum)\b/.test(line)) return "type";
  if (/\bclass\b/.test(line)) return "class";
  if (/\bfunction\b/.test(line)) return "function";
  if (/\bconst\b/.test(line)) return "constant";
  return "variable";
}

/**
 * Builds a definition card from a same-file binding the analyzer never stored.
 *
 * Nested `const` bindings and other locals are not review units. The file
 * source supplies enough declaration context to build their previews locally.
 */
export function sameFileDeclarationPeek({
  language,
  path,
  source,
  startLine = 1,
  symbol,
}: {
  language: string;
  path: string;
  source: string;
  startLine?: number;
  symbol: string;
}) {
  const focusLine = findImportedDeclarationLine(
    source,
    symbol,
    language,
    startLine,
  );
  if (focusLine === undefined) return undefined;
  const lines = source.split("\n");
  const offset = Math.min(
    Math.max(0, focusLine - startLine - SAME_FILE_PEEK_LEAD_LINES),
    Math.max(0, lines.length - 1),
  );
  const excerpt = lines
    .slice(
      offset,
      offset + SYMBOL_PEEK_MAXIMUM_LINES + SAME_FILE_PEEK_LEAD_LINES * 2,
    )
    .join("\n");
  const excerptLines = excerpt.split("\n");
  return {
    kind: "definition" as const,
    endLine: startLine + offset + Math.max(0, excerptLines.length - 1),
    focusLine,
    language,
    name: symbol,
    path,
    source: excerpt,
    startLine: startLine + offset,
    unitKind: declarationKindFromLine(lines[focusLine - startLine] ?? ""),
  };
}

/**
 * Prefers a parsed unit, then a same-file source scan, when either is elsewhere.
 *
 * An analyzed unit that already covers the hovered line is the code on screen,
 * so it is skipped. A scanned excerpt may still include that line as context,
 * and must not be silenced for that: only sitting on the declaration itself
 * is treated as already answered.
 */
export function localDefinitionForPeek<
  T extends { endLine: number; path: string; startLine: number },
  S extends {
    endLine: number;
    focusLine: number;
    path: string;
    startLine: number;
  },
>(
  analyzed: T | undefined,
  scanned: S | undefined,
  read: { line?: number; path: string },
) {
  if (analyzed && !definitionIsWhereTheNameWasRead(analyzed, read)) {
    return analyzed;
  }
  if (
    scanned &&
    (read.line === undefined ||
      scanned.path !== read.path ||
      read.line !== scanned.focusLine)
  ) {
    return scanned;
  }
  return undefined;
}

export interface PeekPlacement {
  left: number;
  maxHeight: number;
  top: number;
  placement: "above" | "below";
}

/**
 * Places the definition card against the name it explains.
 *
 * The card prefers the space under the name, flips above when that space is
 * the smaller of the two, and is always held inside the viewport so a name at
 * the edge of the diff still explains itself somewhere readable.
 */
export function peekPlacement(
  anchor: { bottom: number; left: number; top: number },
  viewport: { height: number; width: number },
  card: { width: number; minimumHeight: number } = {
    width: SYMBOL_PEEK_CARD_WIDTH,
    minimumHeight: 120,
  },
): PeekPlacement {
  const margin = 12;
  const below = Math.max(0, viewport.height - anchor.bottom - margin);
  const above = Math.max(0, anchor.top - margin);
  const placement =
    below >= card.minimumHeight || below >= above ? "below" : "above";
  // The card scrolls its own excerpt, so it may be shorter than it wants but
  // never taller than the side it was placed on: growing past that would put
  // its own controls off screen.
  const maxHeight = placement === "below" ? below : above;
  return {
    left: Math.max(
      margin,
      Math.min(anchor.left, viewport.width - card.width - margin),
    ),
    maxHeight,
    placement,
    top: placement === "below" ? anchor.bottom + 6 : anchor.top - 6,
  };
}
