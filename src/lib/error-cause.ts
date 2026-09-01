/** Returns the innermost `.cause` within a bounded walk. */
export function deepestCause(cause: unknown, maxDepth = 5) {
  let current = cause;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (
      typeof current !== "object" ||
      current === null ||
      !("cause" in current) ||
      current.cause === undefined
    ) {
      break;
    }
    current = current.cause;
  }
  return current;
}
