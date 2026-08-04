const INTERNAL_ERROR_MESSAGE =
  "ReviewDuck could not complete this request. Please try again.";

interface InternalErrorDetails {
  name: string;
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
}

/** Hides implementation details from unexpected tRPC responses. */
export function publicTrpcErrorMessage(code: string, message: string) {
  return code === "INTERNAL_SERVER_ERROR" ? INTERNAL_ERROR_MESSAGE : message;
}

/** Extracts non-secret structural diagnostics from the deepest server failure. */
export function internalErrorDetails(cause: unknown): InternalErrorDetails {
  let current = cause;
  for (let depth = 0; depth < 5; depth += 1) {
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
  const record =
    typeof current === "object" && current !== null
      ? (current as Record<string, unknown>)
      : undefined;
  /** Returns one bounded diagnostic string without coercing arbitrary values. */
  const diagnosticString = (value: unknown) =>
    typeof value === "string" && value.length > 0
      ? value.slice(0, 160)
      : undefined;
  return {
    name:
      current instanceof Error
        ? current.name
        : (diagnosticString(record?.name) ?? "UnknownError"),
    code: diagnosticString(record?.code),
    constraint: diagnosticString(record?.constraint),
    table: diagnosticString(record?.table),
    column: diagnosticString(record?.column),
  };
}
