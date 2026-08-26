import { builtinTypes, keywords, type SyntaxToken } from "./highlight-tokens";

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
 * The token's text is the authority for reserved words: a Tree-sitter class
 * of `tok-keyword` used to be inherited by Python `keyword_argument` values,
 * and imported constants written as `name=VALUE` must still open a definition.
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
  definition: { endLine: number; path: string; startLine: number },
  read: { line?: number; path: string },
) {
  return (
    read.line !== undefined &&
    definition.path === read.path &&
    read.line >= definition.startLine &&
    read.line <= definition.endLine
  );
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
