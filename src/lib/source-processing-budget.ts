/** Largest source upgraded from lexical tokens to a browser syntax tree. */
export const MAX_CLIENT_PARSE_LENGTH = 64 * 1024;

/** Largest source scanned into individual tokens on the browser thread. */
export const MAX_CLIENT_TOKENIZE_LENGTH = 256 * 1024;

/** Long generated lines can overwhelm both the parser and token rendering. */
export const MAX_CLIENT_SOURCE_LINE_LENGTH = 4 * 1024;

/** Reports a generated or minified line without allocating a line array. */
function hasLongSourceLine(source: string) {
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline;
    if (end - start > MAX_CLIENT_SOURCE_LINE_LENGTH) return true;
    start = end + 1;
  }
  return false;
}

/** Keeps large documents readable without building thousands of token spans. */
export function canTokenizeClientSource(source: string) {
  return (
    source.length <= MAX_CLIENT_TOKENIZE_LENGTH && !hasLongSourceLine(source)
  );
}

/** Applies the same parser budget to highlighting and import navigation. */
export function canParseClientSource(source: string) {
  return source.length <= MAX_CLIENT_PARSE_LENGTH && !hasLongSourceLine(source);
}
