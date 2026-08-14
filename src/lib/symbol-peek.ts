import { builtinTypes, keywords, type SyntaxToken } from "./highlight-tokens";

/** Longest excerpt a definition preview shows before the reader scrolls it. */
export const SYMBOL_PEEK_MAXIMUM_LINES = 18;

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

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const NAMED_CLASSES = new Set(["tok-function", "tok-typeName", ""]);

/**
 * Decides whether a highlighted token names something worth looking up.
 *
 * Only declared names can have a definition, so string bodies, comments,
 * numbers, operators and the language's own keywords are excluded before a
 * single lookup is issued. Unclassified tokens stay eligible because the
 * lexical fallback highlighter leaves plain identifiers unclassed.
 */
export function isPeekableToken(
  token: Pick<SyntaxToken, "className" | "text">,
) {
  const text = token.text;
  if (!IDENTIFIER.test(text)) return false;
  const lower = text.toLowerCase();
  if (keywords.has(lower) || builtinTypes.has(lower)) return false;
  const className = token.className;
  return (
    NAMED_CLASSES.has(className) || className.startsWith("tok-variableName")
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
    width: 460,
    minimumHeight: 120,
  },
): PeekPlacement {
  const margin = 12;
  const below = viewport.height - anchor.bottom - margin;
  const above = anchor.top - margin;
  const placement =
    below >= card.minimumHeight || below >= above ? "below" : "above";
  const maxHeight = Math.max(
    card.minimumHeight,
    placement === "below" ? below : above,
  );
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
